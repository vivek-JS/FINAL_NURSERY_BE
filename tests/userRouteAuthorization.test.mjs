import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userRoutePath = path.resolve(__dirname, "../routes/user.route.js");

describe("user route authorization", () => {
  it("limits dealer ledger repair to SUPER_ADMIN users", async () => {
    const source = await readFile(userRoutePath, "utf8");
    const routeMatch = source.match(
      /\.post\(\s*"\/dealers\/:dealerId\/ledger\/repair"[\s\S]*?postRepairDealerLedger\s*\)/
    );

    assert.ok(routeMatch, "dealer ledger repair route should be registered");
    assert.match(routeMatch[0], /authenticateToken/);
    assert.match(routeMatch[0], /authorizeRoles\(\s*\[\s*"SUPER_ADMIN"\s*\]\s*\)/);
  });
});
