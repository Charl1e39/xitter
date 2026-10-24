// Admin > Server update (self-update.ts): which repositories and branches an
// admin's input names, and SELF_UPDATE_REPOS.
import { expect, test } from "bun:test";
import { parseRepo, repoAllowed, validBranch } from "../src/self-update";

test("repositories are owner/name or their github.com address", () => {
	expect(parseRepo("Xittered/xitter")).toBe("Xittered/xitter");
	expect(parseRepo(" https://github.com/Xittered/xitter/ ")).toBe("Xittered/xitter");
	expect(parseRepo("https://github.com/Xittered/xitter.git")).toBe("Xittered/xitter");
	expect(parseRepo("github.com/some-one/my.fork")).toBe("some-one/my.fork");
	for (const bad of ["", "xitter", "https://gitlab.com/a/b", "http://github.com/a/b", "a/b/c", "a/..", "-x/y z", "file:///etc", "a/b;rm"]) expect(parseRepo(bad)).toBeNull();
});

test("branch names git takes and that aren't options", () => {
	for (const ok of ["main", "dev", "feature/self-update", "v1.2", "release_3"]) expect(validBranch(ok)).toBe(true);
	for (const bad of ["", "-f", "--upload-pack=x", "a..b", "a//b", "a/", "a.lock", "a/.b", "x@{1}", "a b", "a;b"]) expect(validBranch(bad)).toBe(false);
});

test("SELF_UPDATE_REPOS limits the repositories, in any case", () => {
	const before = process.env.SELF_UPDATE_REPOS;
	try {
		delete process.env.SELF_UPDATE_REPOS;
		expect(repoAllowed("anyone/anything")).toBe(true);
		process.env.SELF_UPDATE_REPOS = "Xittered/xitter, me/fork";
		expect(repoAllowed("xittered/XITTER")).toBe(true);
		expect(repoAllowed("me/fork")).toBe(true);
		expect(repoAllowed("someone/else")).toBe(false);
	} finally {
		if (before === undefined) delete process.env.SELF_UPDATE_REPOS;
		else process.env.SELF_UPDATE_REPOS = before;
	}
});
