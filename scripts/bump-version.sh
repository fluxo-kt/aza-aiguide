#!/usr/bin/env bash
# Bump version in ALL version-bearing files atomically.
# Usage: ./scripts/bump-version.sh 0.5.0
#
# Files updated:
#   package.json                    → .version
#   .claude-plugin/plugin.json      → .version
#   .claude-plugin/marketplace.json → .plugins[0].version
#
# After running, you still need to:
#   1. Update CHANGELOG.md
#   2. Commit: git add -A && git commit -m "release: vX.Y.Z"
#   3. Tag:    git tag vX.Y.Z
#   4. Push:   git push && git push --tags

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.5.0"
  exit 1
fi

VERSION="$1"

# Validate semver format (basic)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: '$VERSION' is not a valid semver (expected X.Y.Z)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Update all three files
# Using node for reliable JSON manipulation (available if dist/ runs on node)
node -e "
const fs = require('fs');
const path = require('path');

const version = '$VERSION';
const root = '$ROOT';

const files = [
  { path: path.join(root, 'package.json'), field: ['version'] },
  { path: path.join(root, '.claude-plugin', 'plugin.json'), field: ['version'] },
  { path: path.join(root, '.claude-plugin', 'marketplace.json'), field: ['plugins', 0, 'version'] },
];

for (const file of files) {
  const content = JSON.parse(fs.readFileSync(file.path, 'utf-8'));
  let target = content;
  for (let i = 0; i < file.field.length - 1; i++) {
    target = target[file.field[i]];
  }
  const lastKey = file.field[file.field.length - 1];
  const oldVersion = target[lastKey];
  target[lastKey] = version;
  fs.writeFileSync(file.path, JSON.stringify(content, null, 2) + '\n');
  console.log('  ' + path.relative(root, file.path) + ': ' + oldVersion + ' → ' + version);
}
"

echo ""
echo "All version files updated to $VERSION"
echo ""
echo "Next steps:"
echo "  1. Update CHANGELOG.md"
echo "  2. git add -A && git commit -m 'release: v$VERSION'"
echo "  3. git tag v$VERSION"
echo "  4. git push && git push --tags"
