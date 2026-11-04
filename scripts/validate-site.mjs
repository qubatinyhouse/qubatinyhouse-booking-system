import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const root = process.cwd();
const htmlFiles = [
  "public/index.html",
  "public/admin.html",
  "public/finance.html",
  "public/utility-management.html",
  "public/employee-payments.html"
];
const functionDir = "netlify/functions";
const functionFiles = readdirSync(join(root, functionDir)).filter(name => name.endsWith(".mjs"));
const serverFiles = [
  "netlify/lib/_lib.mjs",
  ...functionFiles.map(name => join(functionDir, name))
];

let checked = 0;
for (const path of serverFiles) {
  const result = spawnSync(process.execPath, ["--check", path], {
    cwd: root, encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("JavaScript syntax check failed for " + path + ": " + (result.stderr || result.stdout));
  }
  checked += 1;
}

for (const path of htmlFiles) {
  const source = readFileSync(join(root, path), "utf8");
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  let inlineCount = 0;
  for (const match of scripts) {
    const code = match[1].trim();
    if (!code) continue;
    new vm.Script(code, { filename: path + "#inline-" + (++inlineCount) });
    checked += 1;
  }
}

console.log("QTH validation passed. Checked " + checked + " server/inline JavaScript modules.");
