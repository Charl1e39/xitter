// X Money's instance shop. Purchases are charged up front and stay pending
// until a moderator or admin approves them; a rejection refunds the wallet.

import { sql } from "./db";
import { newId } from "./ids";
import { hateIn } from "./hate";
import { hasBlockedPhrase } from "./settings";
import { settings } from "./settings";

export class ShopError extends Error {}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function shopItems() {
	return sql`select i.id::text, i.name, i.description, i.price_cents::bigint as price, i.kind, i.badge_id::text,
		b.name as badge_name, i.active
		from money_shop_items i left join custom_badges b on b.id = i.badge_id
		where i.kind <> 'badge' or b.id is not null order by i.created_at desc, i.id desc`;
}

export async function buyShopItem(userId: string, itemId: string, text: string, link: string) {
	if (!settings().money_shop.enabled) throw new ShopError("The shop is closed.");
	if (!/^\d{1,19}$/.test(itemId)) throw new ShopError("That shop item isn't available.");
	text = text.trim();
	link = link.trim();
	if (text.length > 500 || (text && (hateIn(text) || hasBlockedPhrase(text)))) throw new ShopError("That announcement text can't be used.");
	if (link && (!/^https?:\/\/[^\s]+$/i.test(link) || link.length > 500)) throw new ShopError("Use a full http or https link, up to 500 characters.");
	return sql.begin(async (tx) => {
		await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${settings().money.starting_cents}) on conflict (user_id) do nothing`;
		const [item] = await tx`select id::text, name, description, price_cents::bigint as price, kind, badge_id::text
			from money_shop_items where id = ${itemId}::bigint and active for update`;
		if (!item) throw new ShopError("That shop item isn't available.");
		if (item.kind === "announcement" && (!text || !text.trim())) throw new ShopError("Write the announcement you'd like staff to review.");
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
		const payload = item.kind === "announcement" ? { text, link } : { badgeId: item.badge_id };
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
	const products = items.length ? items.filter((i) => i.active).map((i) => `<article class="shop-item"><div><h2>${esc(i.name)}</h2><p class="dim">${esc(i.description || (i.kind === "badge" ? "A custom badge for your profile." : "A custom instance announcement, reviewed by staff."))}</p></div>
		<div class="shop-price">${price(i.price)}</div>
		${i.kind === "announcement" ? `<form method="post" class="shop-form"><label for="shop-text-${esc(i.id)}">Announcement text</label><textarea id="shop-text-${esc(i.id)}" name="text" maxlength="500" required placeholder="What should the announcement say?"></textarea><label for="shop-link-${esc(i.id)}">Optional link</label><input id="shop-link-${esc(i.id)}" name="link" type="url" maxlength="500" placeholder="https://example.com"><input type="hidden" name="item" value="${esc(i.id)}"><button class="pill primary" type="submit">Request approval</button></form>` : `<form method="post" class="shop-form"><input type="hidden" name="item" value="${esc(i.id)}"><button class="pill primary" type="submit">Request badge</button></form>`}
		</article>`).join("") : `<p class="empty">No items are for sale right now.</p>`;
	const states: Record<string, string> = { pending: "Waiting for staff approval", approved: "Approved", rejected: "Rejected · refunded" };
	const history = orders.length ? `<section><h2>Your shop requests</h2><div class="orders">${orders.map((o) => `<div class="order"><div><b>${esc(o.item_name)}</b><div class="dim">${esc(states[o.status] ?? o.status)} · ${new Date(o.created_at).toLocaleDateString()}</div></div><b>${price(o.price)}</b></div>`).join("")}</div></section>` : "";
	return `<section class="shop-head"><div><h1>Money shop</h1><p class="dim">Your balance: <b>${price(balance)}</b>. Every purchase is reviewed by staff. Rejected requests are refunded.</p></div><a class="pill" href="/account/money">Money</a></section>
	${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}<div class="shop-grid">${products}</div>${history}`;
}
