#!/bin/bash
# Re-scelle le bundle après une modification manuelle du code source.
#
# Éditer un fichier dans Contents/Resources/source invalide le sceau des
# ressources du bundle — pas la signature des binaires, qui ne sont pas
# touchés. Une app déjà lancée et hors quarantaine continue de fonctionner ;
# une app sous quarantaine avec un sceau cassé est refusée comme « endommagée ».
# Cette commande remet le sceau d'aplomb en quelques secondes.
#
# On re-signe le bundle EXTÉRIEUR seulement. Les autorisations micro, écran et
# accessibilité sont accrochées au binaire ; ne pas le retoucher est ce qui
# leur donne une chance de survivre.
set -euo pipefail

BUNDLE=$(cd "$(dirname "$0")/../.." && pwd)

echo "SunFlower — re-signing $BUNDLE"
codesign --force --sign - "$BUNDLE"
codesign --verify --strict "$BUNDLE" && echo "Seal is valid."
