import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  isAccountRetryableComboFailure,
  rotateOAuthComboAccount,
} from "../src/combos/account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-combo-account-failover-test");
let previousOpencodexHome: string | undefined;

describe("combo account failover", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("only account-sensitive failures retry another account", () => {
    expect(isAccountRetryableComboFailure(401)).toBe(true);
    expect(isAccountRetryableComboFailure(429)).toBe(true);
    expect(isAccountRetryableComboFailure(503)).toBe(true);
    expect(isAccountRetryableComboFailure(400)).toBe(false);
    expect(isAccountRetryableComboFailure(404)).toBe(false);
  });

  test("rotates an OAuth combo target across untried healthy accounts", async () => {
    await saveCredential("google-antigravity", {
      access: "access-a", refresh: "refresh-a", expires: Date.now() + 3600_000,
      email: "a@example.com", accountId: "account-a",
    });
    await saveCredential("google-antigravity", {
      access: "access-b", refresh: "refresh-b", expires: Date.now() + 3600_000,
      email: "b@example.com", accountId: "account-b",
    });
    const set = getAccountSet("google-antigravity")!;
    const first = set.accounts.find(account => account.credential.accountId === "account-a")!;
    const second = set.accounts.find(account => account.credential.accountId === "account-b")!;
    await setActiveAccount("google-antigravity", first.id);

    const attempted = new Set<string>();
    expect(await rotateOAuthComboAccount("google-antigravity", first.id, attempted, 429)).toBe(second.id);
    expect(getAccountSet("google-antigravity")!.activeAccountId).toBe(second.id);
    expect(await rotateOAuthComboAccount("google-antigravity", second.id, attempted, 429)).toBeNull();
  });

  test("a 401 quarantines the rejected OAuth account", async () => {
    await saveCredential("google-antigravity", {
      access: "access-a", refresh: "refresh-a", expires: Date.now() + 3600_000,
      email: "a@example.com", accountId: "account-a",
    });
    await saveCredential("google-antigravity", {
      access: "access-b", refresh: "refresh-b", expires: Date.now() + 3600_000,
      email: "b@example.com", accountId: "account-b",
    });
    const set = getAccountSet("google-antigravity")!;
    const first = set.accounts[0]!;
    await setActiveAccount("google-antigravity", first.id);

    const next = await rotateOAuthComboAccount(
      "google-antigravity",
      first.id,
      new Set<string>(),
      401,
    );
    expect(next).not.toBeNull();
    expect(getAccountSet("google-antigravity")!.accounts.find(account => account.id === first.id)?.needsReauth).toBe(true);
  });
});
