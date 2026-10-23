import { allCountries, countryCode, countryName, regionName } from "./countries";
import { sql } from "./db";

export class ReplyControlError extends Error {
	code = 214;
}

export type ReplyControl = { policy: string | null; selections: string[]; values: string[] };

const COUNTRIES = allCountries();
const REGIONS = new Map([...new Set(COUNTRIES.map((country) => regionName(country.code)).filter((region): region is string => !!region))].sort().map((region) => [region, [region.toLowerCase(), ...COUNTRIES.filter((country) => regionName(country.code) === region).flatMap((country) => [country.code.toLowerCase(), country.name.toLowerCase()])]]));

const MODES: Record<string, string> = { all: "All", community: "Community", by_invitation: "ByInvitation", verified: "Verified", premium: "Premium", my_network: "MyNetwork", followers: "Followers", co: "CountryOfOrigin", country: "Country", Co: "CountryOfOrigin" };

export function replyControl(mode: unknown, selected: unknown = []): ReplyControl {
	const policy = typeof mode === "string" ? MODES[mode] ?? mode : "All";
	let selections: string[] = [], values: string[] = [], selection: string, code: string | undefined;
	if (mode !== undefined && typeof mode !== "string") throw new ReplyControlError("Unknown reply audience.");
	if (policy === "All") return { policy: null, selections, values };
	if (!["Community", "ByInvitation", "Verified", "Premium", "MyNetwork", "Followers", "CountryOfOrigin", "Country"].includes(policy)) throw new ReplyControlError("Unknown reply audience.");
	if (policy === "CountryOfOrigin" || policy === "Country") {
		if (!Array.isArray(selected) || !selected.length || selected.length > 1000 || selected.some((value) => typeof value !== "string" || !value.trim() || value.length > 100)) throw new ReplyControlError("Choose at least one valid country or region.");
		selections = [...new Set(selected.map((value: string) => value.trim()))];
		for (selection of selections) {
			if (policy === "CountryOfOrigin" && REGIONS.has(selection)) {
				values.push(...REGIONS.get(selection)!);
			} else {
				code = countryCode(selection);
				if (policy === "CountryOfOrigin" && !code) throw new ReplyControlError("Unknown region.");
				values.push(...(code ? [code.toLowerCase(), countryName(code)!.toLowerCase()] : [selection, selection.toLowerCase()]));
			}
		}
	}
	return { policy, selections, values: [...new Set(values)] };
}

export async function conversationSettings() {
	const known = new Map(COUNTRIES.map((country) => [country.name.toLowerCase(), { label: country.name, value: country.code }]));
	const custom = await sql`select value from reply_country_catalog where account_count > 0 order by value`;
	const regions = [...REGIONS.keys()];
	let row: any, value: string;
	for (row of custom) {
		value = row.value.trim();
		if (!countryCode(value) && !known.has(value.toLowerCase())) known.set(value.toLowerCase(), { label: value, value });
	}
	return { data: { get_conversation_control_settings: { settings: [
		{ policy: "MyNetwork", available: true },
		{ policy: "Co", available: true, preferences: { __typename: "GeoPreferences", available_preferences: regions.map((region) => ({ label: region, value: region })) } },
		{ policy: "Country", available: true, preferences: { __typename: "GeoPreferences", available_preferences: [...known.values()].sort((a, b) => a.label.localeCompare(b.label)) } },
	] } } };
}

export const replyRestricted = (userId: string) => sql`exists (select 1 from posts r where r.id = p.conversation_id and ${replyDenied(userId)})`;

export const replyDenied = (userId: string) => sql`r.reply_policy is not null and r.user_id <> ${userId}::bigint and not (
	(r.reply_policy in ('Community', 'MyNetwork') and exists (select 1 from follows f where f.follower_id = r.user_id and f.followee_id = ${userId}::bigint))
	or (r.reply_policy = 'MyNetwork' and exists (select 1 from follows f join follows ff on ff.follower_id = f.followee_id where f.follower_id = r.user_id and ff.followee_id = ${userId}::bigint))
	or (r.reply_policy = 'Followers' and exists (select 1 from follows f where f.follower_id = ${userId}::bigint and f.followee_id = r.user_id))
	or exists (select 1 from post_mentions m where m.post_id = r.id and m.user_id = ${userId}::bigint)
	or (r.reply_policy in ('Verified', 'Premium') and exists (select 1 from users x where x.id = ${userId}::bigint and (x.verified_type is not null or exists (select 1 from affiliations af where af.user_id = x.id))))
	or (r.reply_policy in ('Country', 'CountryOfOrigin') and exists (select 1 from users x where x.id = ${userId}::bigint and (coalesce(nullif(trim(x.based_in_override), ''), trim(x.country)) = any(r.reply_allowed_values) or lower(coalesce(nullif(trim(x.based_in_override), ''), trim(x.country))) = any(r.reply_allowed_values))))
)`;
