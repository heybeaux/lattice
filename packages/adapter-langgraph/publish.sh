#!/bin/bash
# Publish lattice-langgraph to PyPI
# Requires: twine, build, and PyPI API token

set -e

echo "Building lattice-langgraph..."
python -m build

echo ""
echo "Uploading to PyPI..."
python -m twine upload --username __token__ --password "$PYPI_API_TOKEN" dist/*

echo ""
echo "✓ lattice-langgraph published to PyPI!"
