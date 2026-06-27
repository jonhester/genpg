import { expect, test } from "vite-plus/test";
import { camelCase, pascalCase } from "../src/naming.ts";

test("pascalCase", () => {
  expect(pascalCase("GetUser")).toBe("GetUser");
  expect(pascalCase("get_user")).toBe("GetUser");
  expect(pascalCase("list-users-by-status")).toBe("ListUsersByStatus");
});

test("camelCase", () => {
  expect(camelCase("GetUser")).toBe("getUser");
  expect(camelCase("get_user")).toBe("getUser");
  expect(camelCase("ListUsers")).toBe("listUsers");
});
