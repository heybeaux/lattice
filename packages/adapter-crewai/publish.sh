#!/bin/bash
# Publish lattice-crewai to PyPI
set -e
echo "Building lattice-crewai..."
python -m build
echo ""
echo "Uploading to PyPI..."
python -m twine upload --username __token__ --password "$PYPI_API_TOKEN" dist/*
echo ""
echo "✓ lattice-crewai published to PyPI!"
