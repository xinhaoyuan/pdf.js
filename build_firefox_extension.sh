#!/bin/bash

set -euo pipefail

gulp chromium
(cd build/chromium && zip -r -FS ../ext.zip ./)
echo "Extension built at $PWD/build/ext.zip"
echo "Remember to also disable xpinstall.signatures.required in Firefox."
