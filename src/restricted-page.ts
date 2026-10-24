import type { Viewer } from "./auth";
import { accountPage, esc } from "./account-page";
import { sql } from "./db";

export const restrictedReason = (message?: string | null, sanction?: string | null) =>
	message ?? sanction ?? "The instance team has restricted this account.";

export const restrictedBody = (reason: string) => `<h1>Your account is restricted</h1>
	<p>You can still read Xitter, but you can't interact with posts, send messages, or change account data while this restriction is active.</p>
	<div class="card strike"><strong>Reason</strong><p>${esc(reason)}</p></div>
	<p>If you think this restriction was made in error, <a href="/appeal">submit an appeal</a>. Include any context that may help the instance team review the decision.</p>`;

export async function restrictedPage(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "GET") return new Response(null, { status: 405 });

	const [[message], [sanction]] = await Promise.all([
		sql`select body from staff_messages
			where user_id = ${viewer.id}::bigint and revoked_at is null
			order by id desc limit 1`,
		sql`select detail->>'reason' as reason from audit_log
			where target = ${viewer.id} and action in ('set_status', 'temporary_status', 'escalate')
				and detail->>'reason' is not null
			order by id desc limit 1`,
	]);
	const body = restrictedBody(restrictedReason(message?.body, sanction?.reason));
	return accountPage({
		req,
		viewer,
		title: "Account restricted",
		status: 403,
		body,
		back: { href: "/home", label: "Back to home" },
	});
}
