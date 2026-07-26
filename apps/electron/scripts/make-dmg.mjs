// Fabrique `SunFlower.dmg` : icône → staging → bundle → signature → image.
//
// Tout se passe sur ta machine, rien n'est envoyé nulle part. La signature est
// ad-hoc par défaut — pas de compte Apple Developer requis — et bascule en
// Developer ID + notarisation dès qu'on lui donne une identité, sans toucher
// au script (voir le tableau des variables plus bas).
//
//   node scripts/make-dmg.mjs [--skip-icon] [--skip-stage] [--versioned]
//
// Variables d'environnement :
//   SUNFLOWER_SIGN_IDENTITY   défaut « - » (ad-hoc). Une vraie identité
//                             (« Developer ID Application: … (TEAMID) »)
//                             active le runtime durci et les entitlements.
//   SUNFLOWER_NOTARY_PROFILE  profil notarytool. ABSENT = pas de notarisation.
//   SUNFLOWER_APPLE_ID        + SUNFLOWER_APPLE_PASSWORD + SUNFLOWER_TEAM_ID
//                             alternative au profil (mot de passe applicatif).
//   SUNFLOWER_ENTITLEMENTS    défaut scripts/entitlements.plist
//   SUNFLOWER_SKIP_SIGN       à 1, ne signe rien (débogage).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, cpSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const scripts = path.join(appRoot, "scripts");
const distApp = path.join(appRoot, "dist-app");
const bundle = path.join(distApp, "SunFlower.app");
const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));

const env = process.env;
const identity = env.SUNFLOWER_SIGN_IDENTITY ?? "-";
const adhoc = identity === "-";
const entitlements = path.resolve(
  env.SUNFLOWER_ENTITLEMENTS ?? path.join(scripts, "entitlements.plist"),
);

if (process.platform !== "darwin") {
  console.error("make-dmg: macOS only (needs codesign and hdiutil).");
  process.exit(1);
}

const step = (label) => process.stdout.write(`\n── ${label}\n`);
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.error) {
    console.error(`make-dmg: cannot run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
};

/* ── 1. l'icône ─────────────────────────────────────────────────────── */

if (!args.includes("--skip-icon")) {
  step("icon");
  run(process.execPath, [path.join(scripts, "make-icon.mjs")]);
} else if (!existsSync(path.join(appRoot, "assets", "SunFlower.icns"))) {
  console.error("make-dmg: --skip-icon but assets/SunFlower.icns does not exist.");
  process.exit(1);
}

/* ── 2. le staging ──────────────────────────────────────────────────── */

if (!args.includes("--skip-stage")) {
  step("staging source and dependencies");
  run(process.execPath, [path.join(scripts, "stage-deps.mjs")]);
}

/* ── 3. le bundle ───────────────────────────────────────────────────── */

step("app bundle");
run(process.execPath, [
  path.join(scripts, "make-app.mjs"),
  "--bundled",
  path.join(distApp, "staging"),
]);

/* ── 4. la signature ────────────────────────────────────────────────── */

// De l'intérieur vers l'extérieur : `--deep` est déprécié par Apple, et signer
// un conteneur avant son contenu invalide la signature du conteneur.
function sign(target, { isApp = false } = {}) {
  const argv = ["--force", "--sign", identity, "--timestamp" + (adhoc ? "=none" : "")];
  if (!adhoc) {
    // Runtime durci : exigé pour la notarisation, inutile (et parfois
    // gênant) en ad-hoc — donc conditionné à l'identité, pas à un drapeau.
    argv.push("--options", "runtime");
    if (isApp && existsSync(entitlements)) {
      argv.push("--entitlements", entitlements);
    }
  }
  argv.push(target);
  const r = spawnSync("codesign", argv, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`make-dmg: codesign failed on ${target}`);
    process.exit(1);
  }
}

/** Les Mach-O imbriqués, du plus profond au plus superficiel. */
function nestedBinaries() {
  const found = [];
  const push = (p) => existsSync(p) && found.push(p);

  // Le binaire d'esbuild : un vrai exécutable, lancé pendant une
  // recompilation dans le bundle. Non signé, il serait tué à l'exec.
  const vendorBin = path.join(
    bundle, "Contents", "Resources", "vendor", "node_modules", "@esbuild",
  );
  if (existsSync(vendorBin)) {
    const r = spawnSync("find", [vendorBin, "-type", "f", "-perm", "-u+x"], {
      encoding: "utf8",
    });
    for (const line of (r.stdout ?? "").split("\n")) if (line) found.push(line);
  }

  const fw = path.join(bundle, "Contents", "Frameworks");
  if (existsSync(fw)) {
    const r = spawnSync(
      "find",
      [fw, "-maxdepth", "1", "(", "-name", "*.framework", "-o", "-name", "*.app", ")"],
      { encoding: "utf8" },
    );
    for (const line of (r.stdout ?? "").split("\n")) if (line) found.push(line);
  }
  push(path.join(bundle, "Contents", "MacOS", "SunFlower-bin"));
  return found;
}

if (env.SUNFLOWER_SKIP_SIGN === "1") {
  step("signing skipped (SUNFLOWER_SKIP_SIGN=1)");
} else {
  step(adhoc ? "signing (ad-hoc)" : `signing (${identity})`);
  for (const target of nestedBinaries()) sign(target);
  sign(bundle, { isApp: true });
  run("codesign", ["--verify", "--strict", bundle]);
}

/* ── 5. l'image disque ──────────────────────────────────────────────── */

step("disk image");

// hdiutil plutôt que create-dmg : exiger Homebrew pour fabriquer un installeur
// « zéro prérequis » se contredirait. hdiutil est livré avec macOS.
const dmgRoot = path.join(distApp, "dmg");
rmSync(dmgRoot, { recursive: true, force: true });
mkdirSync(dmgRoot, { recursive: true });
cpSync(bundle, path.join(dmgRoot, "SunFlower.app"), {
  recursive: true,
  verbatimSymlinks: true,
});
symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
const readme = path.join(scripts, "dmg-readme.txt");
if (existsSync(readme)) cpSync(readme, path.join(dmgRoot, "README.txt"));

const dmgName = args.includes("--versioned")
  ? `SunFlower-${pkg.version}-${process.arch}.dmg`
  : "SunFlower.dmg";
const dmgPath = path.join(distApp, dmgName);
rmSync(dmgPath, { force: true });
run("hdiutil", [
  "create",
  "-volname", "SunFlower",
  "-srcfolder", dmgRoot,
  "-ov",
  "-format", "UDZO",
  "-fs", "HFS+",
  dmgPath,
]);

if (!adhoc && env.SUNFLOWER_SKIP_SIGN !== "1") sign(dmgPath);

/* ── 6. la notarisation, seulement si elle est configurée ───────────── */

const profile = env.SUNFLOWER_NOTARY_PROFILE;
const appleId = env.SUNFLOWER_APPLE_ID;
if (!adhoc && (profile || (appleId && env.SUNFLOWER_APPLE_PASSWORD && env.SUNFLOWER_TEAM_ID))) {
  step("notarizing");
  const argv = ["notarytool", "submit", dmgPath, "--wait"];
  if (profile) argv.push("--keychain-profile", profile);
  else {
    argv.push(
      "--apple-id", appleId,
      "--password", env.SUNFLOWER_APPLE_PASSWORD,
      "--team-id", env.SUNFLOWER_TEAM_ID,
    );
  }
  run("xcrun", argv);
  run("xcrun", ["stapler", "staple", dmgPath]);
} else if (!adhoc) {
  process.stdout.write(
    "\nnote: signed but not notarized — set SUNFLOWER_NOTARY_PROFILE to notarize.\n",
  );
}

/* ── fini ───────────────────────────────────────────────────────────── */

// `du` plutôt que statSync : la taille d'un dossier n'est pas celle de son
// contenu, et c'est le poids du bundle qui intéresse.
const mb = (p) => {
  if (statSync(p).isFile()) return (statSync(p).size / 1024 / 1024).toFixed(0);
  const r = spawnSync("du", ["-sm", p], { encoding: "utf8" });
  return r.stdout?.trim().split(/\s+/)[0] ?? "?";
};
process.stdout.write(
  `\n${dmgName} → ${path.relative(appRoot, dmgPath)} (${mb(dmgPath)} MB, app ${mb(bundle)} MB)\n` +
    `  architecture: ${process.arch} — built from this Mac's Electron runtime.\n` +
    (adhoc
      ? "  signature: ad-hoc. Installed from this Mac there is no Gatekeeper\n" +
        "  prompt at all; if the image travels, see README.txt on the image.\n"
      : "  signature: Developer ID.\n"),
);
