import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  RunDelegatedSuccessorMarker,
  RunRecord,
  RunSuccessorRelation
} from "../../types.js";
import { normalizeFsPath } from "../../utils/fs.js";

export const TOPIC_PROBE_CONFIRMATORY_RELATION: RunSuccessorRelation =
  "topic_probe_confirmatory";
export const TOPIC_PROBE_REPEAT_RELATION: RunSuccessorRelation =
  "topic_probe_repeat";
export const TOPIC_PROBE_DEFERRED_CANDIDATE_RELATION: RunSuccessorRelation =
  "topic_probe_deferred_candidate";
export const TOPIC_PROBE_PORTFOLIO_REFRESH_RELATION: RunSuccessorRelation =
  "topic_probe_portfolio_refresh";
export const TOPIC_PROBE_EVIDENCE_REPAIR_RELATION: RunSuccessorRelation =
  "topic_probe_evidence_repair";

export type RunPromotionLeaseStatus =
  | "available"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type RunPromotionTerminalStatus = Extract<
  RunPromotionLeaseStatus,
  "completed" | "failed" | "canceled"
>;

export interface RunPromotionReservationInput {
  parentRunId: string;
  parentResearchCycle: number;
  relation: RunSuccessorRelation;
  outcomeContentSha256: string;
  childRunId: string;
  receiptContentSha256: string;
  receiptJson: string;
  immutablePayloadJson: string;
  expectedParentStateSha256: string;
  expectedCheckpointSeq: number;
}

export interface RunPromotionReservation {
  parentRunId: string;
  parentResearchCycle: number;
  relation: RunSuccessorRelation;
  outcomeContentSha256: string;
  childRunId: string;
  receiptContentSha256: string;
  receiptJson: string;
  receiptJsonSha256: string;
  immutablePayloadJson: string;
  immutablePayloadJsonSha256: string;
  parentStateSha256: string;
  reservedAt: string;
}

export interface ReserveOrLoadResult {
  status: "reserved" | "loaded";
  reservation: RunPromotionReservation;
}

export interface RunPromotionExecutionState {
  childRunId: string;
  status: RunPromotionLeaseStatus;
  fenceToken: number;
  ownerId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAtMs?: number;
  terminalAt?: string;
  terminalDetail?: string;
}

export interface RunPromotionExecutionLease
  extends RunPromotionExecutionState {
  status: "running";
  ownerId: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAtMs: number;
}

export type ClaimExecutionResult =
  | {
      status: "claimed";
      reclaimed: boolean;
      lease: RunPromotionExecutionLease;
    }
  | {
      status: "busy";
      state: RunPromotionExecutionState;
    }
  | {
      status: "terminal";
      state: RunPromotionExecutionState;
    };

interface PromotionReceiptRow {
  parent_run_id: string;
  parent_research_cycle: number;
  relation: string;
  outcome_content_sha256: string;
  child_run_id: string;
  receipt_content_sha256: string;
  receipt_json: string;
  receipt_json_sha256: string;
  immutable_payload_json: string;
  immutable_payload_json_sha256: string;
  parent_state_sha256: string;
  reserved_at: string;
}

interface PromotionLeaseRow {
  child_run_id: string;
  status: string;
  fence_token: number;
  owner_id?: string | null;
  claimed_at?: string | null;
  heartbeat_at?: string | null;
  lease_expires_at_ms?: number | null;
  terminal_at?: string | null;
  terminal_detail?: string | null;
}

interface ParentRunIndexRow {
  run_json: string;
}

interface CheckpointSeqRow {
  checkpoint_seq?: number | null;
}

export class RunPromotionStore {
  private readonly db: Database.Database;

  constructor(
    filePath: string,
    private readonly now: () => number = () => Date.now()
  ) {
    const normalizedFilePath = normalizeFsPath(filePath);
    mkdirSync(path.dirname(normalizedFilePath), { recursive: true });
    this.db = new Database(normalizedFilePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_promotion_receipt (
        parent_run_id TEXT NOT NULL,
        parent_research_cycle INTEGER NOT NULL CHECK(parent_research_cycle >= 0),
        relation TEXT NOT NULL,
        outcome_content_sha256 TEXT NOT NULL,
        child_run_id TEXT NOT NULL,
        receipt_content_sha256 TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        receipt_json_sha256 TEXT NOT NULL,
        immutable_payload_json TEXT NOT NULL,
        immutable_payload_json_sha256 TEXT NOT NULL,
        parent_state_sha256 TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        PRIMARY KEY (parent_run_id, parent_research_cycle, relation),
        UNIQUE (relation, outcome_content_sha256),
        UNIQUE (child_run_id)
      );

      CREATE TABLE IF NOT EXISTS run_promotion_execution_lease (
        child_run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'available'
          CHECK(status IN ('available', 'running', 'completed', 'failed', 'canceled')),
        fence_token INTEGER NOT NULL DEFAULT 0 CHECK(fence_token >= 0),
        owner_id TEXT,
        claimed_at TEXT,
        heartbeat_at TEXT,
        lease_expires_at_ms INTEGER,
        terminal_at TEXT,
        terminal_detail TEXT,
        FOREIGN KEY (child_run_id)
          REFERENCES run_promotion_receipt(child_run_id)
      );

      CREATE TRIGGER IF NOT EXISTS run_promotion_receipt_immutable_update
      BEFORE UPDATE ON run_promotion_receipt
      BEGIN
        SELECT RAISE(ABORT, 'run_promotion_receipt_immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS run_promotion_receipt_immutable_delete
      BEFORE DELETE ON run_promotion_receipt
      BEGIN
        SELECT RAISE(ABORT, 'run_promotion_receipt_immutable');
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  reserveOrLoad(input: RunPromotionReservationInput): ReserveOrLoadResult {
    validateReservationInput(input);
    return this.withImmediateTransaction(() => {
      const parent = this.loadAndValidateParent(input);
      const byParent = this.selectByParent(
        input.parentRunId,
        input.parentResearchCycle,
        input.relation
      );
      if (byParent) {
        const reservation = parseReservationRow(byParent);
        assertReservationCoreMatches(reservation, input);
        this.applyParentMarker(parent, reservation);
        return { status: "loaded", reservation };
      }

      const byOutcome = this.selectByOutcome(
        input.relation,
        input.outcomeContentSha256
      );
      if (byOutcome) {
        const reservation = parseReservationRow(byOutcome);
        if (
          reservation.parentRunId !== input.parentRunId
          || reservation.parentResearchCycle !== input.parentResearchCycle
          || reservation.relation !== input.relation
        ) {
          throw new Error("run_promotion_outcome_identity_conflict");
        }
        assertReservationCoreMatches(reservation, input);
        this.applyParentMarker(parent, reservation);
        return { status: "loaded", reservation };
      }

      if (this.selectByChild(input.childRunId)) {
        throw new Error("run_promotion_child_identity_conflict");
      }
      const unrelatedChild = this.db
        .prepare("SELECT id FROM run_index WHERE id = ?")
        .get(input.childRunId);
      if (unrelatedChild) {
        throw new Error("run_promotion_child_run_id_conflict");
      }

      const reservedAt = new Date(this.now()).toISOString();
      const reservation: RunPromotionReservation = {
        parentRunId: input.parentRunId,
        parentResearchCycle: input.parentResearchCycle,
        relation: input.relation,
        outcomeContentSha256: input.outcomeContentSha256,
        childRunId: input.childRunId,
        receiptContentSha256: input.receiptContentSha256,
        receiptJson: input.receiptJson,
        receiptJsonSha256: sha256Text(input.receiptJson),
        immutablePayloadJson: input.immutablePayloadJson,
        immutablePayloadJsonSha256: sha256Text(input.immutablePayloadJson),
        parentStateSha256: input.expectedParentStateSha256,
        reservedAt
      };
      this.db.prepare(`
        INSERT INTO run_promotion_receipt (
          parent_run_id,
          parent_research_cycle,
          relation,
          outcome_content_sha256,
          child_run_id,
          receipt_content_sha256,
          receipt_json,
          receipt_json_sha256,
          immutable_payload_json,
          immutable_payload_json_sha256,
          parent_state_sha256,
          reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.parentRunId,
        reservation.parentResearchCycle,
        reservation.relation,
        reservation.outcomeContentSha256,
        reservation.childRunId,
        reservation.receiptContentSha256,
        reservation.receiptJson,
        reservation.receiptJsonSha256,
        reservation.immutablePayloadJson,
        reservation.immutablePayloadJsonSha256,
        reservation.parentStateSha256,
        reservation.reservedAt
      );
      this.db.prepare(`
        INSERT INTO run_promotion_execution_lease (
          child_run_id,
          status,
          fence_token
        ) VALUES (?, 'available', 0)
      `).run(reservation.childRunId);
      this.applyParentMarker(parent, reservation);
      return { status: "reserved", reservation };
    });
  }

  getByParentRunId(parentRunId: string): RunPromotionReservation | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM run_promotion_receipt
      WHERE parent_run_id = ?
      ORDER BY parent_research_cycle DESC, reserved_at DESC
      LIMIT 1
    `).get(parentRunId) as PromotionReceiptRow | undefined;
    return row ? parseReservationRow(row) : undefined;
  }

  getByParentCycle(
    parentRunId: string,
    parentResearchCycle: number,
    relation: RunSuccessorRelation
  ): RunPromotionReservation | undefined {
    const row = this.selectByParent(parentRunId, parentResearchCycle, relation);
    return row ? parseReservationRow(row) : undefined;
  }

  getByChildRunId(childRunId: string): RunPromotionReservation | undefined {
    const row = this.selectByChild(childRunId);
    return row ? parseReservationRow(row) : undefined;
  }

  claimExecution(input: {
    childRunId: string;
    ownerId: string;
    leaseDurationMs: number;
  }): ClaimExecutionResult {
    validateExecutionInput(input);
    return this.withImmediateTransaction(() => {
      if (!this.selectByChild(input.childRunId)) {
        throw new Error("run_promotion_reservation_missing");
      }
      const current = this.requireExecutionState(input.childRunId);
      if (isTerminalStatus(current.status)) {
        return { status: "terminal", state: current };
      }

      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const active =
        current.status === "running"
        && typeof current.leaseExpiresAtMs === "number"
        && current.leaseExpiresAtMs > nowMs;
      if (active && current.ownerId !== input.ownerId) {
        return { status: "busy", state: current };
      }

      const sameOwner = active && current.ownerId === input.ownerId;
      const fenceToken = sameOwner
        ? current.fenceToken
        : current.fenceToken + 1;
      const claimedAt = sameOwner && current.claimedAt
        ? current.claimedAt
        : nowIso;
      const leaseExpiresAtMs = nowMs + input.leaseDurationMs;
      const updated = this.db.prepare(`
        UPDATE run_promotion_execution_lease
        SET
          status = 'running',
          fence_token = ?,
          owner_id = ?,
          claimed_at = ?,
          heartbeat_at = ?,
          lease_expires_at_ms = ?,
          terminal_at = NULL,
          terminal_detail = NULL
        WHERE child_run_id = ?
          AND status IN ('available', 'running')
      `).run(
        fenceToken,
        input.ownerId,
        claimedAt,
        nowIso,
        leaseExpiresAtMs,
        input.childRunId
      );
      if (updated.changes !== 1) {
        throw new Error("run_promotion_execution_claim_conflict");
      }
      const lease = this.requireExecutionState(input.childRunId);
      if (!isActiveLease(lease)) {
        throw new Error("run_promotion_execution_claim_invalid");
      }
      return {
        status: "claimed",
        reclaimed: !sameOwner && current.fenceToken > 0,
        lease
      };
    });
  }

  heartbeat(input: {
    childRunId: string;
    ownerId: string;
    fenceToken: number;
    leaseDurationMs: number;
  }): RunPromotionExecutionLease {
    validateExecutionInput(input);
    validateFenceToken(input.fenceToken);
    return this.withImmediateTransaction(() => {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const updated = this.db.prepare(`
        UPDATE run_promotion_execution_lease
        SET
          heartbeat_at = ?,
          lease_expires_at_ms = ?
        WHERE child_run_id = ?
          AND status = 'running'
          AND owner_id = ?
          AND fence_token = ?
      `).run(
        nowIso,
        nowMs + input.leaseDurationMs,
        input.childRunId,
        input.ownerId,
        input.fenceToken
      );
      if (updated.changes !== 1) {
        throw new Error("run_promotion_execution_fence_stale");
      }
      const lease = this.requireExecutionState(input.childRunId);
      if (!isActiveLease(lease)) {
        throw new Error("run_promotion_execution_heartbeat_invalid");
      }
      return lease;
    });
  }

  markTerminal(input: {
    childRunId: string;
    ownerId: string;
    fenceToken: number;
    status: RunPromotionTerminalStatus;
    detail?: string;
  }): RunPromotionExecutionState {
    validateExecutionInput({ ...input, leaseDurationMs: 1 });
    validateFenceToken(input.fenceToken);
    return this.withImmediateTransaction(() => {
      const current = this.requireExecutionState(input.childRunId);
      if (
        current.status === input.status
        && current.ownerId === input.ownerId
        && current.fenceToken === input.fenceToken
      ) {
        return current;
      }
      if (isTerminalStatus(current.status)) {
        throw new Error("run_promotion_execution_already_terminal");
      }

      const terminalAt = new Date(this.now()).toISOString();
      const updated = this.db.prepare(`
        UPDATE run_promotion_execution_lease
        SET
          status = ?,
          terminal_at = ?,
          terminal_detail = ?,
          lease_expires_at_ms = NULL
        WHERE child_run_id = ?
          AND status = 'running'
          AND owner_id = ?
          AND fence_token = ?
      `).run(
        input.status,
        terminalAt,
        normalizeOptionalText(input.detail) ?? null,
        input.childRunId,
        input.ownerId,
        input.fenceToken
      );
      if (updated.changes !== 1) {
        throw new Error("run_promotion_execution_fence_stale");
      }
      return this.requireExecutionState(input.childRunId);
    });
  }

  getExecutionState(childRunId: string): RunPromotionExecutionState | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM run_promotion_execution_lease
      WHERE child_run_id = ?
    `).get(childRunId) as PromotionLeaseRow | undefined;
    return row ? parseExecutionRow(row) : undefined;
  }

  private loadAndValidateParent(
    input: RunPromotionReservationInput
  ): { run: RunRecord } {
    const raw = this.db.prepare(`
      SELECT run_json
      FROM run_index
      WHERE id = ?
    `).get(input.parentRunId) as ParentRunIndexRow | undefined;
    if (!raw) {
      throw new Error("run_promotion_parent_missing");
    }
    let run: RunRecord;
    try {
      run = JSON.parse(raw.run_json) as RunRecord;
    } catch {
      throw new Error("run_promotion_parent_index_invalid");
    }
    assertParentEligible(run, input);

    const checkpoint = this.db.prepare(`
      SELECT MAX(checkpoint_seq) AS checkpoint_seq
      FROM run_checkpoint_index
      WHERE run_id = ?
    `).get(input.parentRunId) as CheckpointSeqRow | undefined;
    const indexedCheckpointSeq =
      typeof checkpoint?.checkpoint_seq === "number"
        ? checkpoint.checkpoint_seq
        : 0;
    if (
      indexedCheckpointSeq !== input.expectedCheckpointSeq
      || (run.graph?.checkpointSeq ?? 0) !== input.expectedCheckpointSeq
    ) {
      throw new Error("run_promotion_parent_checkpoint_changed");
    }
    return { run };
  }

  private applyParentMarker(
    parent: { run: RunRecord },
    reservation: RunPromotionReservation
  ): void {
    const marker = buildDelegatedSuccessorMarker(reservation);
    if (
      parent.run.delegatedSuccessor
      && !sameMarker(parent.run.delegatedSuccessor, marker)
    ) {
      throw new Error("run_promotion_parent_marker_conflict");
    }
    if (sameMarker(parent.run.delegatedSuccessor, marker)) {
      return;
    }

    const updated: RunRecord = {
      ...parent.run,
      delegatedSuccessor: marker,
      updatedAt: maxIso(parent.run.updatedAt, reservation.reservedAt)
    };
    const result = this.db.prepare(`
      UPDATE run_index
      SET
        updated_at = ?,
        run_json = ?
      WHERE id = ?
    `).run(updated.updatedAt, JSON.stringify(updated), updated.id);
    if (result.changes !== 1) {
      throw new Error("run_promotion_parent_marker_write_failed");
    }
    parent.run = updated;
  }

  private selectByParent(
    parentRunId: string,
    parentResearchCycle: number,
    relation: RunSuccessorRelation
  ): PromotionReceiptRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM run_promotion_receipt
      WHERE parent_run_id = ?
        AND parent_research_cycle = ?
        AND relation = ?
    `).get(parentRunId, parentResearchCycle, relation) as
      | PromotionReceiptRow
      | undefined;
  }

  private selectByOutcome(
    relation: RunSuccessorRelation,
    outcomeContentSha256: string
  ): PromotionReceiptRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM run_promotion_receipt
      WHERE relation = ?
        AND outcome_content_sha256 = ?
    `).get(relation, outcomeContentSha256) as
      | PromotionReceiptRow
      | undefined;
  }

  private selectByChild(childRunId: string): PromotionReceiptRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM run_promotion_receipt
      WHERE child_run_id = ?
    `).get(childRunId) as PromotionReceiptRow | undefined;
  }

  private requireExecutionState(childRunId: string): RunPromotionExecutionState {
    const state = this.getExecutionState(childRunId);
    if (!state) {
      throw new Error("run_promotion_execution_state_missing");
    }
    return state;
  }

  private withImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }
}

export function buildPromotionParentStateSha256(run: RunRecord): string {
  const reviewState = run.graph?.nodeStates?.review;
  return sha256Text(JSON.stringify({
    id: run.id,
    status: run.status,
    currentNode: run.currentNode,
    graphCurrentNode: run.graph?.currentNode,
    researchCycle: run.graph?.researchCycle,
    checkpointSeq: run.graph?.checkpointSeq,
    reviewState: reviewState
      ? {
          status: reviewState.status,
          updatedAt: reviewState.updatedAt,
          note: reviewState.note,
          lastError: reviewState.lastError
        }
      : null,
    pendingTransition: run.graph?.pendingTransition ?? null
  }));
}

export function buildDelegatedSuccessorMarker(
  reservation: RunPromotionReservation
): RunDelegatedSuccessorMarker {
  return {
    schemaVersion: 1,
    state: "delegated",
    relation: reservation.relation,
    parentResearchCycle: reservation.parentResearchCycle,
    childRunId: reservation.childRunId,
    outcomeContentSha256: reservation.outcomeContentSha256,
    receiptContentSha256: reservation.receiptContentSha256,
    reservedAt: reservation.reservedAt
  };
}

export function assertRunHasNoDelegatedSuccessor(
  run: RunRecord,
  operation: string
): void {
  const marker = run.delegatedSuccessor;
  if (!marker || marker.state !== "delegated") {
    return;
  }
  throw new Error(
    `run_delegated_to_successor:${operation}:${marker.childRunId}`
  );
}

function assertParentEligible(
  run: RunRecord,
  input: RunPromotionReservationInput
): void {
  if (run.id !== input.parentRunId) {
    throw new Error("run_promotion_parent_identity_mismatch");
  }
  if (run.graph?.researchCycle !== input.parentResearchCycle) {
    throw new Error("run_promotion_parent_cycle_changed");
  }
  if (
    run.status !== "paused"
    || run.currentNode !== "review"
    || run.graph?.currentNode !== "review"
    || run.graph?.nodeStates?.review?.status !== "needs_approval"
  ) {
    throw new Error("run_promotion_parent_not_paused_at_review");
  }
  const pending = run.graph?.pendingTransition;
  if (
    pending?.action !== "delegate_successor"
    || pending.sourceNode !== "review"
    || pending.autoExecutable !== true
    || pending.targetNode !== undefined
  ) {
    throw new Error("run_promotion_parent_delegation_not_authorized");
  }
  if (
    buildPromotionParentStateSha256(run)
    !== input.expectedParentStateSha256
  ) {
    throw new Error("run_promotion_parent_state_changed");
  }
}

function assertReservationCoreMatches(
  reservation: RunPromotionReservation,
  input: RunPromotionReservationInput
): void {
  if (
    reservation.parentRunId !== input.parentRunId
    || reservation.parentResearchCycle !== input.parentResearchCycle
    || reservation.relation !== input.relation
  ) {
    throw new Error("run_promotion_parent_cycle_relation_conflict");
  }
  if (reservation.outcomeContentSha256 !== input.outcomeContentSha256) {
    throw new Error("run_promotion_outcome_identity_conflict");
  }
  if (reservation.childRunId !== input.childRunId) {
    throw new Error("run_promotion_child_identity_conflict");
  }
}

function parseReservationRow(
  row: PromotionReceiptRow
): RunPromotionReservation {
  const reservation: RunPromotionReservation = {
    parentRunId: row.parent_run_id,
    parentResearchCycle: row.parent_research_cycle,
    relation: requireRelation(row.relation),
    outcomeContentSha256: row.outcome_content_sha256,
    childRunId: row.child_run_id,
    receiptContentSha256: row.receipt_content_sha256,
    receiptJson: row.receipt_json,
    receiptJsonSha256: row.receipt_json_sha256,
    immutablePayloadJson: row.immutable_payload_json,
    immutablePayloadJsonSha256: row.immutable_payload_json_sha256,
    parentStateSha256: row.parent_state_sha256,
    reservedAt: row.reserved_at
  };
  if (
    sha256Text(reservation.receiptJson)
      !== reservation.receiptJsonSha256
    || sha256Text(reservation.immutablePayloadJson)
      !== reservation.immutablePayloadJsonSha256
  ) {
    throw new Error("run_promotion_immutable_payload_hash_mismatch");
  }
  return reservation;
}

function parseExecutionRow(row: PromotionLeaseRow): RunPromotionExecutionState {
  const status = requireLeaseStatus(row.status);
  return {
    childRunId: row.child_run_id,
    status,
    fenceToken: row.fence_token,
    ownerId: normalizeOptionalText(row.owner_id),
    claimedAt: normalizeOptionalText(row.claimed_at),
    heartbeatAt: normalizeOptionalText(row.heartbeat_at),
    leaseExpiresAtMs:
      typeof row.lease_expires_at_ms === "number"
        ? row.lease_expires_at_ms
        : undefined,
    terminalAt: normalizeOptionalText(row.terminal_at),
    terminalDetail: normalizeOptionalText(row.terminal_detail)
  };
}

function validateReservationInput(input: RunPromotionReservationInput): void {
  if (!hasText(input.parentRunId)) {
    throw new Error("run_promotion_parent_run_id_invalid");
  }
  if (
    !Number.isInteger(input.parentResearchCycle)
    || input.parentResearchCycle < 0
  ) {
    throw new Error("run_promotion_parent_cycle_invalid");
  }
  requireRelation(input.relation);
  for (const value of [
    input.outcomeContentSha256,
    input.receiptContentSha256,
    input.expectedParentStateSha256
  ]) {
    if (!isSha256(value)) {
      throw new Error("run_promotion_sha256_invalid");
    }
  }
  if (!isUuid(input.childRunId)) {
    throw new Error("run_promotion_child_run_id_invalid");
  }
  if (!hasText(input.receiptJson) || !hasText(input.immutablePayloadJson)) {
    throw new Error("run_promotion_immutable_payload_missing");
  }
  if (
    !Number.isInteger(input.expectedCheckpointSeq)
    || input.expectedCheckpointSeq < 0
  ) {
    throw new Error("run_promotion_checkpoint_seq_invalid");
  }
}

function validateExecutionInput(input: {
  childRunId: string;
  ownerId: string;
  leaseDurationMs: number;
}): void {
  if (!isUuid(input.childRunId)) {
    throw new Error("run_promotion_child_run_id_invalid");
  }
  if (!hasText(input.ownerId)) {
    throw new Error("run_promotion_execution_owner_invalid");
  }
  if (
    !Number.isInteger(input.leaseDurationMs)
    || input.leaseDurationMs <= 0
  ) {
    throw new Error("run_promotion_execution_lease_duration_invalid");
  }
}

function validateFenceToken(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("run_promotion_execution_fence_invalid");
  }
}

function isActiveLease(
  state: RunPromotionExecutionState
): state is RunPromotionExecutionLease {
  return state.status === "running"
    && hasText(state.ownerId)
    && hasText(state.claimedAt)
    && hasText(state.heartbeatAt)
    && typeof state.leaseExpiresAtMs === "number";
}

function isTerminalStatus(
  status: RunPromotionLeaseStatus
): status is RunPromotionTerminalStatus {
  return status === "completed"
    || status === "failed"
    || status === "canceled";
}

function requireLeaseStatus(value: string): RunPromotionLeaseStatus {
  if (
    value === "available"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "canceled"
  ) {
    return value;
  }
  throw new Error("run_promotion_execution_state_invalid");
}

function requireRelation(value: string): RunSuccessorRelation {
  if (
    value === TOPIC_PROBE_CONFIRMATORY_RELATION
    || value === TOPIC_PROBE_REPEAT_RELATION
    || value === TOPIC_PROBE_DEFERRED_CANDIDATE_RELATION
    || value === TOPIC_PROBE_PORTFOLIO_REFRESH_RELATION
    || value === TOPIC_PROBE_EVIDENCE_REPAIR_RELATION
  ) {
    return value;
  }
  throw new Error("run_promotion_relation_invalid");
}

function sameMarker(
  left: RunDelegatedSuccessorMarker | undefined,
  right: RunDelegatedSuccessorMarker
): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function normalizeOptionalText(
  value: string | null | undefined
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
