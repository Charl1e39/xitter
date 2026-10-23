// Home instances hold wallets. Cross-instance payments use a durable outbox:
// the sender debits once, and the recipient credits once after a signed request.
import { sql } from "./db";
import { INSTANCE_ID, isPeer, peers, signedAnswer, signedFetch, type Incoming } from "./federation";
import { newId } from "./ids";
import { BADGE_TYPES, sniffImage } from "./media";
import { hateIn } from "./hate";
import { feature, hasBlockedPhrase, settings } from "./settings";

let pumping = false;

export async function discoverMoneyAccount(value: string): Promise<void> {
	const m = /^([A-Za-z0-9_]{1,15})@([a-z0-9.-]{1,253}(?::\d{1,5})?)$/i.exec(value);
	if (!m || !isPeer(m[2].toLowerCase())) return;
	const response = await signedFetch(m[2].toLowerCase(), "GET", `/federation/v1/users/by-name/${encodeURIComponent(m[1])}`, undefined, 512 * 1024);
	if (response.status === 200) await import("./federation-sync").then(({ applyUser }) => applyUser(m[2].toLowerCase(), response.json()));
}

export async function moneyFederationApi(incoming: Incoming, method: string, path: string): Promise<Response | undefined> {
	const [route, query = ""] = path.split("?", 2);
	if (method === "GET" && route === "/federation/v1/money/shop") {
		if (!feature("money") || !settings().money_shop.enabled) return signedAnswer(incoming, 200, { items: [], next: null });
		const after = new URLSearchParams(query).get("after") ?? "";
		if (after && !/^\d{1,19}$/.test(after)) return signedAnswer(incoming, 400, { error: "Invalid catalog cursor." });
		const items = await sql`select i.id::text, i.name, i.description, i.price_cents::bigint as price, i.kind,
			b.name as badge_name, b.image as badge_image, b.mime as badge_mime
			from money_shop_items i left join custom_badges b on b.id = i.badge_id
			where i.status = 'approved' and i.active and (i.kind <> 'badge' or b.id is not null)
			${after ? sql`and i.id < ${after}::bigint` : sql``}
			order by i.id desc limit 8`;
		const shared: any[] = [];
		for (const i of items as any[]) {
			let badge = null;
			if (i.kind === "badge") {
				const image = Buffer.from(i.badge_image);
				badge = { name: i.badge_name, mime: i.badge_mime, image: image.toString("base64") };
			}
			shared.push({ id: i.id, name: i.name, description: i.description, price: Number(i.price), kind: i.kind, badge });
		}
		return signedAnswer(incoming, 200, { items: shared, next: items.length === 8 ? items[items.length - 1].id : null });
	}
	if (method !== "POST" || route !== "/federation/v1/money/transfer") return undefined;
	if (!feature("money")) return signedAnswer(incoming, 404, { error: "Equicoins is not enabled here." });
	if (!isPeer(incoming.from)) return signedAnswer(incoming, 403, { error: "This instance does not accept Equicoins transfers from that peer." });
	let body: any;
	try { body = incoming.json(); } catch { return signedAnswer(incoming, 400, { error: "Invalid transfer." }); }
	const transferId = String(body?.transferId ?? "");
	const senderRef = String(body?.sender ?? "");
	const senderMatch = /^(\d{1,19})@([a-z0-9.-]{1,253}(?::\d{1,5})?)$/i.exec(senderRef);
	const recipientId = String(body?.recipient ?? "");
	const amount = Number(body?.amount);
	const note = typeof body?.note === "string" ? body.note : "";
	if (!/^\d{1,19}$/.test(transferId) || !senderMatch || senderMatch[2].toLowerCase() !== incoming.from || !/^\d{1,19}$/.test(recipientId) ||
		!Number.isSafeInteger(amount) || amount <= 0 || amount > settings().money.max_transfer_cents || note.length > 140)
		return signedAnswer(incoming, 400, { error: "Invalid transfer." });
	// the same rule as a local payment's note; refusing sends the money back to the sender
	if (note && (hateIn(note) || hasBlockedPhrase(note))) return signedAnswer(incoming, 422, { error: "That note can't be sent." });
	const senderId = await import("./federation-sync").then(({ resolveUser }) => resolveUser(senderRef)).catch(() => undefined);
	if (!senderId) return signedAnswer(incoming, 404, { error: "The sender account could not be verified." });
	const [recipient] = await sql`select id::text, status from users where id = ${recipientId}::bigint and instance is null and deactivated_at is null`;
	if (!recipient || recipient.status === "suspended") return signedAnswer(incoming, 404, { error: "The recipient account is unavailable." });
	const [sender] = await sql`select status from users where id = ${senderId}::bigint`;
	if (!sender || sender.status === "suspended") return signedAnswer(incoming, 403, { error: "The sender account is unavailable." });
	const [blocked] = await sql`select 1 from blocks where (blocker_id = ${senderId}::bigint and blocked_id = ${recipientId}::bigint) or (blocker_id = ${recipientId}::bigint and blocked_id = ${senderId}::bigint) limit 1`;
	if (blocked) return signedAnswer(incoming, 403, { error: "This transfer is blocked." });
	try {
		const duplicate = await sql.begin(async (tx) => {
			const [receipt] = await tx`insert into money_federation_receipts (origin, transfer_id) values (${incoming.from}, ${transferId}::bigint)
				on conflict do nothing returning 1`;
			if (!receipt) return true;
			await tx`insert into money_wallets (user_id, balance_cents) values (${recipientId}::bigint, ${settings().money.starting_cents}) on conflict (user_id) do nothing`;
			await tx`update money_wallets set balance_cents = balance_cents + ${amount} where user_id = ${recipientId}::bigint`;
			const localId = newId();
			await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, federation_status)
				values (${localId}::bigint, ${senderId}::bigint, ${recipientId}::bigint, ${amount}, ${note}, ${`federation:${incoming.from}:${transferId}`}, 'complete')`;
			return false;
		});
		return signedAnswer(incoming, 200, { accepted: true, duplicate });
	} catch (e) {
		console.error("Equicoins federation transfer failed:", e instanceof Error ? e.message : e);
		return signedAnswer(incoming, 500, { error: "The transfer could not be recorded." });
	}
}

async function syncRemoteShop(instance: string) {
	const catalogItems: any[] = [];
	let after = "";
	for (let page = 0; page < 100; page++) {
		const response = await signedFetch(instance, "GET", `/federation/v1/money/shop${after ? `?after=${after}` : ""}`, undefined, 4 * 1024 * 1024);
		// a peer on a version without Equicoins has no shop to share
		if (response.status === 404 && !after) break;
		if (response.status !== 200) throw new Error(`shop catalog answered ${response.status}`);
		const catalog = response.json();
		if (!Array.isArray(catalog?.items) || catalog.items.length > 8 || (catalog.next !== null && !/^\d{1,19}$/.test(String(catalog.next)))) throw new Error("invalid shop catalog");
		catalogItems.push(...catalog.items);
		if (catalog.next === null) break;
		after = String(catalog.next);
	}
	if (catalogItems.length >= 800) throw new Error("shop catalog is over the sync limit");
	const valid: any[] = [];
	for (const raw of catalogItems) {
		if (!/^\d{1,19}$/.test(String(raw?.id ?? "")) || typeof raw.name !== "string" || !raw.name.trim() || [...raw.name].length > 60 ||
			typeof raw.description !== "string" || [...raw.description].length > 240 || !Number.isSafeInteger(raw.price) || raw.price <= 0 || raw.price > 1_000_000_000 ||
			!["badge", "custom_badge", "announcement"].includes(raw.kind)) continue;
		let badge: { name: string; mime: string; image: Buffer } | undefined;
		if (raw.kind === "badge") {
			const item = raw.badge;
			if (typeof item?.name !== "string" || !item.name.trim() || [...item.name].length > 60 || typeof item.image !== "string" || item.image.length > 350_000 ||
				!BADGE_TYPES.includes(item.mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.image)) continue;
			const image = Buffer.from(item.image, "base64");
			const info = sniffImage(image);
			if (image.length > 256 * 1024 || !info || info.mime !== item.mime || info.width > 1024 || info.height > 1024) continue;
			badge = { name: item.name.trim(), mime: item.mime, image };
		}
		valid.push({ id: String(raw.id), name: raw.name.trim(), description: raw.description, price: raw.price, kind: raw.kind, badge });
	}
	await sql.begin(async (tx) => {
		const ids = valid.map((i) => i.id);
		await tx`update money_remote_shop_items set source_active = false, updated_at = now() where origin = ${instance}`;
		for (const item of valid) {
			const badge = item.badge;
			await tx`insert into money_remote_shop_items (origin, remote_id, name, description, price_cents, kind, badge_name, badge_image, badge_mime, source_active)
				values (${instance}, ${item.id}::bigint, ${item.name}, ${item.description}, ${item.price}, ${item.kind}, ${badge?.name ?? null}, ${badge?.image ?? null}, ${badge?.mime ?? null}, true)
				on conflict (origin, remote_id) do update set
					status = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime)
						then 'pending' else money_remote_shop_items.status end,
					active = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime)
						then false else money_remote_shop_items.active end,
					reviewed_by = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime)
						then null else money_remote_shop_items.reviewed_by end,
					reviewed_at = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime)
						then null else money_remote_shop_items.reviewed_at end,
					name = excluded.name, description = excluded.description, price_cents = excluded.price_cents, kind = excluded.kind,
					badge_name = excluded.badge_name, badge_image = excluded.badge_image, badge_mime = excluded.badge_mime,
					source_active = true, updated_at = now()`;
		}
		if (ids.length) await tx`update money_remote_shop_items set source_active = false where origin = ${instance} and not (remote_id = any(${sql.array(ids, "INT8")}))`;
	});
}

let syncingShop = false;
async function syncShops() {
	if (syncingShop || !feature("money") || !settings().money_shop.enabled) return;
	syncingShop = true;
	try {
		await Promise.all(peers().map((peer) => syncRemoteShop(peer.id).catch((e) => console.error(`Equicoins shop sync ${peer.id}:`, e instanceof Error ? e.message : e))));
		const active = peers().map((p) => p.id);
		await sql`update money_remote_shop_items set source_active = false where not (origin = any(${sql.array(active, "TEXT")}))`;
	} finally { syncingShop = false; }
}

async function pumpOnce() {
	if (pumping) return;
	pumping = true;
	try {
		const rows = await sql`select o.transfer_id::text, o.destination, o.sender_id::text, o.recipient_id::text, o.amount_cents::bigint as amount,
			o.note, o.attempts from money_federation_outbox o join money_transfers t on t.id = o.transfer_id
			where o.next_attempt <= now() and t.federation_status = 'pending' order by o.next_attempt limit 10`;
		for (const r of rows) {
			let status = 0, accepted = false;
			try {
				const response = await signedFetch(r.destination, "POST", "/federation/v1/money/transfer", {
					transferId: r.transfer_id,
					sender: `${r.sender_id}@${INSTANCE_ID}`,
					recipient: r.recipient_id,
					amount: Number(r.amount),
					note: r.note,
				}, 64 * 1024);
				status = response.status;
				accepted = status >= 200 && status < 300 && response.json()?.accepted === true;
			} catch (e) {
				await sql`update money_federation_outbox set attempts = attempts + 1, next_attempt = now() + interval '1 minute', last_error = ${String(e).slice(0, 300)} where transfer_id = ${r.transfer_id}::bigint`;
				continue;
			}
			if (accepted) {
				await sql.begin(async (tx) => {
					await tx`update money_transfers set federation_status = 'complete' where id = ${r.transfer_id}::bigint and federation_status = 'pending'`;
					await tx`delete from money_federation_outbox where transfer_id = ${r.transfer_id}::bigint`;
				});
			} else if (status >= 400 && status < 500 && status !== 429) {
				await sql.begin(async (tx) => {
					const [sent] = await tx`update money_transfers set federation_status = 'failed' where id = ${r.transfer_id}::bigint and federation_status = 'pending' returning sender_id::text, amount_cents`;
					if (sent) await tx`update money_wallets set balance_cents = balance_cents + ${Number(sent.amount_cents)} where user_id = ${sent.sender_id}::bigint`;
					await tx`delete from money_federation_outbox where transfer_id = ${r.transfer_id}::bigint`;
				});
			} else {
				const delay = Math.min(60, 2 ** Math.min(Number(r.attempts) + 1, 6));
				await sql`update money_federation_outbox set attempts = attempts + 1, next_attempt = now() + ${delay} * interval '1 minute', last_error = ${`remote status ${status}`}
					where transfer_id = ${r.transfer_id}::bigint`;
			}
		}
	} finally { pumping = false; }
}

export function startMoneyFederation() {
	void pumpOnce();
	setInterval(() => void pumpOnce().catch((e) => console.error("Equicoins federation queue:", e)), 15_000).unref();
	void syncShops();
	setInterval(() => void syncShops().catch((e) => console.error("Equicoins shop sync:", e)), 5 * 60_000).unref();
}
