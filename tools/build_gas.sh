#!/usr/bin/env bash
# gas/ の各ファイルを、Apps Script に貼り付けやすい1ファイル（gas_bundle/Code.gs）にまとめる
set -euo pipefail
cd "$(dirname "$0")/.."
out=gas_bundle/Code.gs
{
  echo "/**"
  echo " * 不動産SNS自動投稿 — Apps Script 用の1ファイル版（tools/build_gas.sh で gas/ から生成）"
  echo " * Apps Script の「コード.gs」の中身をすべて消して、このファイルの内容を貼り付けてください。"
  echo " */"
  for f in Config Sheets Social Line Main WebApp Setup; do
    echo; echo "// ===================== ${f}.gs ====================="; echo
    cat "gas/${f}.gs"
  done
} > "$out"
cp gas/Settings.html gas_bundle/Settings.html
cp gas/appsscript.json gas_bundle/appsscript.json
echo "wrote $out ($(wc -l < "$out") lines)"
