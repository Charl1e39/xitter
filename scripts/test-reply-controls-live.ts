import assert from "node:assert/strict";
import { sql } from "../src/db";
import { newId } from "../src/ids";

type Session = { headers: Record<string, string>; token: string };

export async function signIn(origin: string, username: string, password: string): Promise<Session> {
	const response = await fetch(`${origin}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username, password }) });
	const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
	const csrf = cookies.find((cookie) => cookie.startsWith("ct0="))?.slice(4);
	const token = cookies.find((cookie) => cookie.startsWith("auth_token="))?.slice(11);
	assert(csrf && token, `Could not sign in as ${username}: ${response.status}`);
	return { headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, token };
}

async function operation(origin: string, session: Session, name: string, variables: object): Promise<any> {
	const response = await fetch(`${origin}/i/api/graphql/q/${name}`, { method: "POST", headers: session.headers, body: JSON.stringify({ variables }) });
	return response.json();
}

async function run() {
	const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000";
	const target = process.argv[2];
	const ownerName = process.env.TEST_OWNER_NAME ?? "test";
	const ownerPassword = process.env.TEST_OWNER_PASSWORD;
	const password = crypto.randomUUID();
	const accounts = [newId(), newId()];
	const names = accounts.map((id) => `probe${id.slice(-10)}`);
	const sessions: Session[] = [];
	let hash: string, owner: Session, mars: Session, venus: Session, post: any, result: any, index: number, control: any;
	assert(target && /^\d{1,19}$/.test(target) && ownerPassword, "Supply the post id and TEST_OWNER_PASSWORD; TEST_OWNER_NAME defaults to test.");
	try {
		owner = await signIn(origin, ownerName, ownerPassword);
		sessions.push(owner);
		[post] = await sql`select p.reply_policy, p.reply_selections, u.screen_name from posts p join users u on u.id = p.user_id where p.id = ${target}::bigint`;
		assert.equal(post?.screen_name, ownerName);
		console.log("Original stored audience:", JSON.stringify({ policy: post.reply_policy, selections: post.reply_selections }));
		assert(!post.reply_policy || (post.reply_policy === "Country" && post.reply_selections.length === 1 && post.reply_selections[0] === "Mars"), "The post's audience changed; refusing to overwrite it.");
		hash = await Bun.password.hash(password);
		for (index = 0; index < accounts.length; index++) {
			await sql`insert into users (id, screen_name, name, password_hash, based_in_override) values (${accounts[index]}::bigint, ${names[index]}, 'Temporary country API probe', ${hash}, ${index === 0 ? "Mars" : "Venus"})`;
			sessions.push(await signIn(origin, names[index], password));
		}
		mars = sessions[1];
		venus = sessions[2];
		result = await operation(origin, owner, "ConversationControlChange", { tweet_id: target, mode: "Country", allowed_country_codes: ["Mars"] });
		assert(!result.errors, JSON.stringify(result.errors));
		[control] = await sql`select reply_policy, reply_selections, reply_allowed_values from posts where id = ${target}::bigint`;
		assert.equal(control.reply_policy, "Country");
		assert.deepEqual(control.reply_selections, ["Mars"]);
		console.log("Saved audience:", JSON.stringify(control));
		result = await operation(origin, mars, "CreateTweet", { tweet_text: "Temporary Mars API reply probe", reply: { in_reply_to_tweet_id: target } });
		assert(result.data?.create_tweet?.tweet_results?.result?.rest_id, JSON.stringify(result));
		console.log("Mars reply: allowed");
		result = await operation(origin, venus, "CreateTweet", { tweet_text: "Temporary Venus API reply probe", reply: { in_reply_to_tweet_id: target } });
		assert.equal(result.errors?.[0]?.code, 433, JSON.stringify(result));
		console.log("Venus reply: rejected with code 433");
		result = await operation(origin, venus, "TweetResultByRestId", { tweetId: target });
		assert.equal(result.data?.tweetResult?.result?.limitedActionResults?.limited_actions?.[0]?.action, "Reply");
		console.log("Venus post view: Reply action restricted");
	} finally {
		await sql`delete from users where id = any(${sql.array(accounts, "INT8")})`;
		if (sessions.length) await sql`delete from sessions where token = any(${sql.array(sessions.map((session) => session.token), "TEXT")})`;
		await sql.close();
	}
}

if (import.meta.main) await run();
