import { Menu, Tray, nativeImage, nativeTheme } from "electron";
import { MENUBAR, MENUBAR_DARK } from "../shared/sunflower-pixels";
import { pixelArtPng } from "./pixel-png";

let tray: Tray | null = null;

function buildTrayImage(): Electron.NativeImage {
  const art = nativeTheme.shouldUseDarkColors ? MENUBAR_DARK : MENUBAR;
  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    dataURL: `data:image/png;base64,${pixelArtPng(art, 2).toString("base64")}`,
  });
  image.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${pixelArtPng(art, 4).toString("base64")}`,
  });
  return image;
}

export function createTray(opts: {
  onClick: (trayBounds: Electron.Rectangle) => void;
  onQuit: () => void;
  /** Compagnon docké ? (lu à l'ouverture du menu : libellé à jour). */
  isCompanionDocked: () => boolean;
  onToggleCompanionDock: () => void;
  /** Sunflower Work autorisé ? (lu à l'ouverture du menu : coche à jour). */
  isWorkEnabled: () => boolean;
  onToggleWork: () => void;
  /** Ouvre l'app Sunflower Work (fenêtre dédiée). */
  onOpenWork: () => void;
}): Tray {
  tray = new Tray(buildTrayImage());
  nativeTheme.on("updated", () => {
    tray?.setImage(buildTrayImage());
  });
  tray.setToolTip("sunflower");
  tray.on("click", () => {
    opts.onClick(tray!.getBounds());
  });
  tray.on("right-click", () => {
    tray!.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: opts.isCompanionDocked()
            ? "let sunflower roam"
            : "dock sunflower to corner",
          click: opts.onToggleCompanionDock,
        },
        { type: "separator" },
        {
          label: "Enable Sunflower Work (experimental)",
          type: "checkbox",
          checked: opts.isWorkEnabled(),
          click: opts.onToggleWork,
        },
        { label: "open Sunflower Work…", click: opts.onOpenWork },
        { type: "separator" },
        { label: "quit sunflower", click: opts.onQuit },
      ]),
    );
  });
  return tray;
}

export function trayBounds(): Electron.Rectangle | null {
  return tray ? tray.getBounds() : null;
}
