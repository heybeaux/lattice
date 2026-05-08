#!/bin/bash
# Lattice Forge Shadow Mode Benchmark Runner
# 
# This script runs the Lattice documentation generation workflow through Forge
# with Lattice shadow mode enabled, collecting benchmark data.
#
# PREREQUISITES:
# 1. Clone this repo alongside your Forge project
# 2. Add the workflow to Forge: cp forge-integration/lattice-docs-workflow.ts ~/forge/src/mastra/workflows/
# 3. Set environment variables (see below)
# 4. Run this script from the Forge directory
#
# ENVIRONMENT VARIABLES:
#   OPENAI_API_KEY        — Required for L3 validation
#   LATTICE_SHADOW_LOG    — Path to audit log (default: ./lattice-shadow-audit.jsonl)
#   LATTICE_TOPICS        — Path to topics JSON (default: ../lattice/forge-integration/lattice-docs-topics.json)
#   LATTICE_MAX_TOPICS    — Max topics to process (default: 50, set lower for testing)
#
# USAGE:
#   cd ~/forge
#   export OPENAI_API_KEY="your-key"
#   bash /path/to/lattice/forge-integration/run-benchmark.sh

set -e

# Configuration
LOG_PATH="${LATTICE_SHADOW_LOG:-./lattice-shadow-audit.jsonl}"
TOPICS_FILE="${LATTICE_TOPICS:-../lattice/forge-integration/lattice-docs-topics.json}"
MAX_TOPICS="${LATTICE_MAX_TOPICS:-50}"
REPORT_PATH="${LATTICE_REPORT:-./lattice-benchmark-report.json}"

echo "═══════════════════════════════════════════════════"
echo "  Lattice Forge Shadow Mode Benchmark"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Audit log:     $LOG_PATH"
echo "Topics file:   $TOPICS_FILE"
echo "Max topics:    $MAX_TOPICS"
echo "Report path:   $REPORT_PATH"
echo ""

# Clear previous audit log
> "$LOG_PATH"

# Check prerequisites
if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: OPENAI_API_KEY is required"
  exit 1
fi

if [ ! -f "$TOPICS_FILE" ]; then
  echo "ERROR: Topics file not found: $TOPICS_FILE"
  exit 1
fi

# Count total topics
TOTAL_TOPICS=$(python3 -c "import json; print(len(json.load(open('$TOPICS_FILE'))))")
echo "Total topics available: $TOTAL_TOPICS"
echo "Processing up to: $MAX_TOPICS"
echo ""

# Start timing
START_TIME=$(date +%s)
COMPLETED=0
FAILED=0

# Process each topic
python3 -c "
import json
import sys

with open('$TOPICS_FILE') as f:
    topics = json.load(f)

for i, topic in enumerate(topics[:int('$MAX_TOPICS')]):
    print(f'{topic[\"topic\"]}|{topic[\"docType\"]}|{topic.get(\"targetAudience\", \"\")}')
" | while IFS='|' read -r TOPIC DOC_TYPE AUDIENCE; do
  COMPLETED=$((COMPLETED + 1))
  echo "[$COMPLETED/$MAX_TOPICS] $TOPIC ($DOC_TYPE)"
  
  # TODO: Trigger the Forge workflow here
  # This depends on your Forge setup. Options:
  # 
  # Option A: Use Forge's CLI/API to trigger the workflow
  #   cd ~/forge && npm run trigger -- lattice-doc-gen --topic="$TOPIC" --docType="$DOC_TYPE"
  #
  # Option B: Call Forge's API directly
  #   curl -X POST http://localhost:3000/api/workflows/lattice-doc-gen \
  #     -H "Content-Type: application/json" \
  #     -d "{\"topic\":\"$TOPIC\",\"docType\":\"$DOC_TYPE\",\"targetAudience\":\"$AUDIENCE\"}"
  #
  # Option C: Use the Mastra SDK directly in a Node script
  #   node -e "const { mastra } = require('./src/mastra'); mastra.getWorkflow('lattice-doc-gen').execute(...)"
  
  # For now, simulate with a placeholder (replace with actual Forge trigger)
  echo "  → Trigger Forge workflow: lattice-doc-gen"
  echo "  → Topic: $TOPIC"
  echo "  → Type: $DOC_TYPE"
  echo "  → Audience: $AUDIENCE"
  
  # Add a small delay to avoid rate limiting
  sleep 2
  
  echo ""
done

# End timing
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "═══════════════════════════════════════════════════"
echo "  Benchmark Complete"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Duration: $((DURATION / 60))m $((DURATION % 60))s"
echo "Completed: $COMPLETED topics"
echo "Failed: $FAILED topics"
echo ""
echo "Audit log: $LOG_PATH"

# Generate report
if [ -f "$LOG_PATH" ]; then
  TOTAL_LINES=$(wc -l < "$LOG_PATH")
  echo "Total handoff validations: $TOTAL_LINES"
  
  # Count passes/fails
  PASSED=$(grep -c '"passed":true' "$LOG_PATH" || echo 0)
  FAILED_VAL=$(grep -c '"passed":false' "$LOG_PATH" || echo 0)
  
  echo "Passed: $PASSED"
  echo "Failed: $FAILED_VAL"
  
  # Count by tier
  L1_COUNT=$(grep -c '"tier":"L1"' "$LOG_PATH" || echo 0)
  L2_COUNT=$(grep -c '"tier":"L2"' "$LOG_PATH" || echo 0)
  L3_COUNT=$(grep -c '"tier":"L3"' "$LOG_PATH" || echo 0)
  
  echo ""
  echo "By tier:"
  echo "  L1: $L1_COUNT"
  echo "  L2: $L2_COUNT"
  echo "  L3: $L3_COUNT"
fi

echo ""
echo "Next steps:"
echo "1. Review audit log: $LOG_PATH"
echo "2. Generate report: node forge-integration/generate-report.js"
echo "3. Publish results"
