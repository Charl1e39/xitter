import { expect, test } from "bun:test";
import { restrictedChatOperation } from "../src/chat";
import { ERROR_SCRIPT } from "../src/errors";
import { restrictedBody, restrictedReason } from "../src/restricted-page";

test("restriction reason prefers the active staff notice", () => {
	expect(restrictedReason("Your posts broke the rules.", "older audit reason")).toBe("Your posts broke the rules.");
	expect(restrictedReason("", "audit reason")).toBe("");
});

test("restriction reason falls back to the sanction audit and default", () => {
	expect(restrictedReason(null, "Repeated rule violations.")).toBe("Repeated rule violations.");
	expect(restrictedReason(null, null)).toBe("The instance team has restricted this account.");
});

test("restricted page content includes the reason and appeal link safely", () => {
	const body = restrictedBody('Reason <script>alert("x")</script>');
	expect(body).toContain("Your account is restricted");
	expect(body).toContain("Reason &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	expect(body).toContain('href="/appeal"');
	expect(body).toContain("can't interact with posts");
});

test("restricted API errors navigate the client to account access", () => {
	expect(ERROR_SCRIPT).toContain('e.code===326');
	expect(ERROR_SCRIPT).toContain('location.assign("/account/access")');
	expect(ERROR_SCRIPT).toContain("XMLHttpRequest.prototype.open");
});

test("restricted accounts retain the direct-message operations", () => {
	expect(restrictedChatOperation("SendMessageCreateMutation")).toBe(true);
	expect(restrictedChatOperation("SendMessageEventMutation")).toBe(true);
	expect(restrictedChatOperation("FavoriteTweet")).toBe(false);
});
