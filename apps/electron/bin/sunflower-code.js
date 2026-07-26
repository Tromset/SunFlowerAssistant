#!/usr/bin/env node
// `sunflower-code` — le harnais de codage, invocable depuis N'IMPORTE QUEL
// dossier. C'est tout l'intérêt d'un bin séparé plutôt que d'un alias vers
// `sunflower code` : le dossier courant devient le dossier de projet, sans
// avoir à taper /cd en arrivant.
//
// Un shim, pas une deuxième app : il délègue à bin/sunflower.js, qui garde la
// résolution d'Electron, la reconstruction si besoin et le filtrage des logs
// natifs.
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const forward = process.argv.slice(2);
// `--cd` explicite l'emporte sur le dossier courant : on peut viser un autre
// projet sans s'y déplacer.
const hasCd = forward.some((arg) => arg === "--cd" || arg.startsWith("--cd="));

const child = spawn(
  process.execPath,
  [
    path.join(__dirname, "sunflower.js"),
    "code",
    ...(hasCd ? [] : ["--cd", process.cwd()]),
    ...forward,
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
