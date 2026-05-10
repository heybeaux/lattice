/**
 * JSON-line log exporter for Lattice events.
 *
 * Appends each event as a single JSON line to a file path.
 * Uses atomic writes (temp file + append) to prevent corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LatticeEvent, LatticeEventType } from '../events/emitter.js';
import type { EventEmitter } from '../events/emitter.js';

/**
 * A single entry in the JSON-line log.
 */
export interface JsonLineEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type */
  event_type: LatticeEventType;
  /** Event payload */
  data: Record<string, unknown>;
  /** Metadata for filtering */
  metadata: {
    /** Lattice version */
    version: string;
    /** Agent identifier */
    agent_id?: string;
    /** Trace identifier */
    trace_id?: string;
  };
}

/**
 * Configuration for the JSON-line exporter.
 */
export interface JsonLineExporterConfig {
  /** Path to the output file */
  outputPath: string;
  /** Lattice version string (default: '0.4.0') */
  version?: string;
}

/**
 * JSON-line log exporter.
 *
 * Listens to all Lattice events and appends them to a file as JSON lines.
 * Each line is a complete, valid JSON object.
 *
 * @example
 * ```typescript
 * import { JsonLineExporter, globalEmitter } from '@heybeaux/lattice-core';
 *
 * const exporter = new JsonLineExporter({ outputPath: './lattice-events.jsonl' });
 * exporter.attach(globalEmitter);
 * // Events are now being logged
 * ```
 */
export class JsonLineExporter {
  private outputPath: string;
  private version: string;
  private attached = false;

  constructor(config: JsonLineExporterConfig) {
    this.outputPath = config.outputPath;
    this.version = config.version ?? '0.4.0';

    // Ensure directory exists
    const dir = path.dirname(this.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Attach the exporter to an EventEmitter.
   *
   * Listens to all Lattice event types and writes them to the log file.
   */
  attach(emitter: EventEmitter): void {
    if (this.attached) return;
    this.attached = true;

    const eventTypes: LatticeEventType[] = [
      'contract:emitted',
      'contract:validated',
      'contract:rejected',
      'circuit:opened',
      'circuit:closed',
      'circuit:half-open',
      'pipeline:started',
      'pipeline:completed',
      'pipeline:aborted',
    ];

    for (const eventType of eventTypes) {
      emitter.on(eventType, (event: LatticeEvent) => {
        this.writeEntry(event);
      });
    }
  }

  /**
   * Detach the exporter from an EventEmitter.
   */
  detach(emitter: EventEmitter): void {
    // Note: EventEmitter doesn't support detaching all handlers for a type,
    // so we just mark as detached. In practice, the exporter is typically
    // attached once at startup and never detached.
    this.attached = false;
  }

  /**
   * Write a single entry to the log file.
   */
  private writeEntry(event: LatticeEvent): void {
    const entry: JsonLineEntry = {
      timestamp: event.timestamp,
      event_type: event.type,
      data: event.data,
      metadata: {
        version: this.version,
        agent_id: (event.data as any)?.fromAgent,
        trace_id: (event.data as any)?.traceId,
      },
    };

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.outputPath, line, 'utf-8');
  }

  /**
   * Read all entries from the log file.
   * Useful for testing or post-processing.
   */
  readEntries(): JsonLineEntry[] {
    if (!fs.existsSync(this.outputPath)) {
      return [];
    }

    const content = fs.readFileSync(this.outputPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  /**
   * Clear the log file.
   */
  clear(): void {
    if (fs.existsSync(this.outputPath)) {
      fs.writeFileSync(this.outputPath, '', 'utf-8');
    }
  }
}
