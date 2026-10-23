// Equicoins shop. Purchases are charged up front and stay pending
// until a moderator or admin approves them; a rejection refunds the wallet.

import { sql } from "./db";
import { newId } from "./ids";
import { hateIn } from "./hate";
import { hasBlockedPhrase } from "./settings";
import { settings } from "./settings";
import { BADGE_TYPES, sniffImage } from "./media";
import { economy } from "./money";

export class ShopError extends Error {}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function shopItems(approvedOnly = false) {
	const local = await sql`select i.id::text, i.name, i.description, i.price_cents::bigint as price, i.kind, i.badge_id::text,
		b.name as badge_name, i.active, i.status, i.created_by::text, i.approved_by::text, u.screen_name as creator
		from money_shop_items i left join custom_badges b on b.id = i.badge_id left join users u on u.id = i.created_by
		where (i.kind <> 'badge' or b.id is not null) and (${approvedOnly} = false or (i.status = 'approved' and i.active)) order by i.created_at desc, i.id desc`;
	if (!approvedOnly) return local;
	const remote = await sql`select remote_id::text as id, name, description, price_cents::bigint as price, kind, null::text as badge_id,
		badge_name, active, status, null::text as created_by, reviewed_by::text as approved_by, origin as creator, origin as remote_origin,
		badge_mime
		from money_remote_shop_items where source_active and active and status = 'approved' order by updated_at desc, remote_id desc`;
	return [...local, ...remote.map((i: any) => ({ ...i, active: !!i.active, badge_url: `/account/money/shop/badge/${encodeURIComponent(i.remote_origin)}/${i.id}` }))];
}

export async function buyShopItem(userId: string, itemId: string, text: string, link: string, badgeName = "", badgeImage?: Buffer) {
	if (!settings().money_shop.enabled) throw new ShopError("The shop is closed.");
	if (!/^\d{1,19}$/.test(itemId)) throw new ShopError("That shop item isn't available.");
	text = text.trim();
	link = link.trim();
	badgeName = badgeName.trim();
	if (text.length > 500 || (text && (hateIn(text) || hasBlockedPhrase(text)))) throw new ShopError("That announcement text can't be used.");
	if (link && (!/^https?:\/\/[^\s]+$/i.test(link) || link.length > 500)) throw new ShopError("Use a full http or https link, up to 500 characters.");
	return sql.begin(async (tx) => {
		await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${economy().starting_cents}) on conflict (user_id) do nothing`;
		const [item] = await tx`select id::text, name, description, price_cents::bigint as price, kind, badge_id::text
			from money_shop_items where id = ${itemId}::bigint and active and status = 'approved' for update`;
		if (!item) throw new ShopError("That shop item isn't available.");
		if (item.kind === "announcement" && (!text || !text.trim())) throw new ShopError("Write the announcement you'd like staff to review.");
		let badgePayload: { name: string; image: string; mime: string } | undefined;
		if (item.kind === "custom_badge") {
			if (!badgeName || [...badgeName].length > 60) throw new ShopError("Badge names are 1 to 60 characters.");
			if (!badgeImage || badgeImage.length > 256 * 1024) throw new ShopError("Upload an image up to 256 KB.");
			const info = sniffImage(badgeImage);
			if (!info || !BADGE_TYPES.includes(info.mime) || info.width > 1024 || info.height > 1024)
				throw new ShopError("Use a PNG, JPEG, WebP or GIF up to 1024×1024 and 256 KB.");
			badgePayload = { name: badgeName, image: badgeImage.toString("base64"), mime: info.mime };
		}
		if (item.kind === "badge") {
			const [owned] = await tx`select 1 from user_badges where user_id = ${userId}::bigint and badge_id = ${item.badge_id}::bigint`;
			if (owned) throw new ShopError("You already have this badge.");
		}
		const [pending] = await tx`select 1 from money_shop_orders where user_id = ${userId}::bigint and item_id = ${itemId}::bigint and status = 'pending'`;
		if (pending) throw new ShopError("You already have a request for this item waiting for approval.");
		const [wallet] = await tx`select balance_cents from money_wallets where user_id = ${userId}::bigint for update`;
		const price = Number(item.price);
		if (Number(wallet.balance_cents) < price) throw new ShopError("You don't have enough money for that.");
		await tx`update money_wallets set balance_cents = balance_cents - ${price} where user_id = ${userId}::bigint`;
		const id = newId();
		const payload = item.kind === "announcement" ? { text, link } : item.kind === "custom_badge" ? badgePayload : { badgeId: item.badge_id };
		await tx`insert into money_shop_orders (id, user_id, item_id, item_name, price_cents, kind, payload)
			values (${id}::bigint, ${userId}::bigint, ${itemId}::bigint, ${item.name}, ${price}, ${item.kind}, ${JSON.stringify(payload)}::text::jsonb)`;
		return { id, name: item.name };
	});
}

export async function myShopOrders(userId: string) {
	return sql`select id::text, item_name, price_cents::bigint as price, kind, status, created_at
		from money_shop_orders where user_id = ${userId}::bigint order by id desc limit 20`;
}

export async function shopView(items: any[], orders: any[], balance: number, error = "", notice = "") {
	const price = (c: number | bigint) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const activeItems = items.filter((i) => i.active);
	const products = activeItems.map((i) => {
		const remote = Boolean(i.remote_origin);
		const kind = i.kind === "announcement" ? "Announcement" : i.kind === "custom_badge" ? "Custom badge" : "Badge";
		const description = i.description || (i.kind === "badge" ? "A badge for your profile." : i.kind === "custom_badge" ? "Your own badge design on your profile." : "An announcement for everyone on the instance.");
		const form = remote
			? `<p class="shop-remote">Listed on ${esc(i.remote_origin)}. Buying from other instances isn’t available yet.</p>`
			: i.kind === "announcement"
			? `<form method="post" class="shop-form"><label for="shop-text-${esc(i.id)}">Announcement text</label><textarea id="shop-text-${esc(i.id)}" name="text" maxlength="500" required placeholder="What should the announcement say?"></textarea><label for="shop-link-${esc(i.id)}">Optional link</label><input id="shop-link-${esc(i.id)}" name="link" type="url" maxlength="500" placeholder="https://example.com"><input type="hidden" name="item" value="${esc(i.id)}"><button class="pill primary" type="submit">Send for review</button></form>`
			: i.kind === "custom_badge"
			? `<form method="post" enctype="multipart/form-data" class="shop-form"><label for="badge-name-${esc(i.id)}">Badge name</label><input id="badge-name-${esc(i.id)}" name="badgeName" maxlength="60" required placeholder="Name your badge"><label>Badge image</label><div class="shop-upload"><input class="shop-file-input" id="badge-image-${esc(i.id)}" name="badgeImage" type="file" accept="${BADGE_TYPES.join(",")}" required><label for="badge-image-${esc(i.id)}"><span>Choose image</span><span class="shop-upload-name" data-file-name>No image chosen</span></label></div><span class="shop-hint">PNG, JPEG, WebP or GIF, up to 256 KB and 1024 × 1024</span><input type="hidden" name="item" value="${esc(i.id)}"><button class="pill primary" type="submit">Send for review</button></form>`
				: `<form method="post" class="shop-form"><input type="hidden" name="item" value="${esc(i.id)}"><button class="pill primary" type="submit">Get this badge</button></form>`;
		const image = i.kind === "badge" ? (remote && i.badge_url
			? `<img class="shop-badge-preview" src="${esc(i.badge_url)}" alt="${esc(i.badge_name || i.name)}">`
			: i.badge_id ? `<img class="shop-badge-preview" src="/public/badge-${esc(i.badge_id)}.png" alt="${esc(i.badge_name || i.name)}">` : "") : "";
		return `<article class="shop-item"><div>${image}<h3>${esc(i.name)}</h3><p class="shop-item-description">${esc(description)}</p><div class="shop-meta"><strong class="shop-price">${price(i.price)}</strong><span class="shop-kind">${kind}</span></div></div>${form}</article>`;
	}).join("");
	const states: Record<string, string> = { pending: "Pending review", approved: "Approved", rejected: "Declined · refunded" };
	const history = orders.length ? `<section class="shop-history"><h2>Your requests</h2><div>${orders.map((o) => `<div class="order"><div class="order-name">${esc(o.item_name)}</div><b class="order-price">${price(o.price)}</b><div class="order-status ${esc(o.status)}">${esc(states[o.status] ?? o.status)} · ${new Date(o.created_at).toLocaleDateString()}</div></div>`).join("")}</div></section>` : "";
	return `<section class="hero shop-hero" aria-label="Balance"><div class="label">Balance</div><div class="amount">${price(balance)}</div><p class="dim">Staff review every request. Declined requests are refunded.</p></section>
	${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}<div class="shop-page"><h2>Items</h2>${activeItems.length ? `<div class="shop-grid">${products}</div>` : `<p class="empty">Nothing in the shop right now.</p>`}${history}</div>`;
}
