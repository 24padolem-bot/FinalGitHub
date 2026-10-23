import {
  HANDOFF_DEFINITIONS,
  AGENT_CONTRACTS
} from "./contracts";
import { canonicalJsonStringify, quickHashSync } from "../utils/crypto";
function runTrustMeshVerification(ctx) {
  const {
    handoffId,
    sourceAgent,
    destAgent,
    claimId,
    sourcePayload,
    receivedPayload,
    messageId,
    sourceVersion,
    destVersion,
    isRetryAttempt,
    simulatedNetworkTimeout
  } = ctx;
  const handoffDef = HANDOFF_DEFINITIONS[handoffId];
  const sourceContract = AGENT_CONTRACTS[sourceAgent];
  const destContract = AGENT_CONTRACTS[destAgent];
  const issues = [];
  const fieldComparisons = [];
  let status = "VERIFIED";
  let severity = "info";
  let requiredAction = "Forward verified payload to downstream agent.";
  if (simulatedNetworkTimeout && !isRetryAttempt) {
    return {
      handoffId,
      sourceAgent,
      destAgent,
      claimId,
      messageId,
      sourceVersion,
      destVersion,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      status: "RECOVERY",
      severity: "high",
      issues: ["Transmission timeout: Connection dropped before destination acknowledgement."],
      fieldComparisons: [],
      sourceHash: quickHashSync(canonicalJsonStringify(sourcePayload)),
      receivedHash: "TIMEOUT_NO_RESPONSE",
      hashMatch: false,
      requiredAction: "Initiating automated authorized retry with state snapshot.",
      auditEventId: `EV-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
      recoveryAttempt: 1
    };
  }
  const sourceCanonical = canonicalJsonStringify(sourcePayload);
  const receivedCanonical = canonicalJsonStringify(receivedPayload);
  const sourceHash = quickHashSync(sourceCanonical);
  const receivedHash = quickHashSync(receivedCanonical);
  const hashMatch = sourceHash === receivedHash;
  for (const requiredField of handoffDef.requiredFields) {
    const valInDest = receivedPayload[requiredField];
    if (valInDest === void 0 || valInDest === null || valInDest === "") {
      issues.push(`Data Loss: Required field '${requiredField}' is missing in received payload.`);
      status = "BLOCKED";
      severity = "high";
      requiredAction = `Halt workflow. Request state restoration for missing required field '${requiredField}'.`;
    }
  }
  const allKeys = Array.from(/* @__PURE__ */ new Set([...Object.keys(sourcePayload), ...Object.keys(receivedPayload)]));
  for (const key of allKeys) {
    const origVal = sourcePayload[key];
    const recVal = receivedPayload[key];
    if (origVal !== void 0 && recVal === void 0) {
      const isReq = handoffDef.requiredFields.includes(key);
      fieldComparisons.push({
        field: key,
        originalValue: origVal,
        receivedValue: null,
        changeType: "missing",
        isAuthorized: false,
        status: isReq ? "fail" : "warning",
        detail: `Field disappeared between ${sourceContract.code} and ${destContract.code}`
      });
      if (isReq) {
        status = "BLOCKED";
        severity = "high";
      }
      continue;
    }
    if (origVal === void 0 && recVal !== void 0) {
      const isAllowedBySource = sourceContract.permittedAdditions.includes(key);
      fieldComparisons.push({
        field: key,
        originalValue: null,
        receivedValue: recVal,
        changeType: "added",
        isAuthorized: isAllowedBySource,
        status: isAllowedBySource ? "pass" : "warning",
        detail: isAllowedBySource ? "Legitimate enrichment" : "Unexpected additional field"
      });
      if (!isAllowedBySource && key.startsWith("unauthorized_")) {
        issues.push(`Unauthorized Access: Field '${key}' exceeds permitted agent scope.`);
        status = "BLOCKED";
        severity = "critical";
        requiredAction = "Strip unauthorized disclosures before proceeding.";
      }
      continue;
    }
    const isOrigNum = typeof origVal === "number";
    const isRecNum = typeof recVal === "number";
    const areValuesEqual = JSON.stringify(origVal) === JSON.stringify(recVal);
    if (areValuesEqual) {
      fieldComparisons.push({
        field: key,
        originalValue: origVal,
        receivedValue: recVal,
        changeType: "unchanged",
        isAuthorized: true,
        status: "pass"
      });
    } else {
      const isProhibited = sourceContract.prohibitedModifications.includes(key) || sourceAgent !== "agent_a" && (key === "claim_id" || key === "policy_number" || key === "customer_name");
      let isCorrupted = false;
      let corruptionReason = "";
      if (isOrigNum && typeof recVal === "string" && isNaN(Number(recVal))) {
        isCorrupted = true;
        corruptionReason = `Numeric field '${key}' corrupted into non-numeric string "${recVal}"`;
      } else if (key.includes("date") && typeof recVal === "string" && (recVal.includes("99") || isNaN(Date.parse(recVal)))) {
        isCorrupted = true;
        corruptionReason = `Date field '${key}' contains invalid timestamp representation "${recVal}"`;
      } else if (key === "currency" && recVal !== "INR") {
        isCorrupted = true;
        corruptionReason = `Currency mutation detected: expected INR, received "${recVal}"`;
      }
      if (isCorrupted) {
        issues.push(`Data Corruption: ${corruptionReason}`);
        fieldComparisons.push({
          field: key,
          originalValue: origVal,
          receivedValue: recVal,
          changeType: "invalid",
          isAuthorized: false,
          status: "fail",
          detail: corruptionReason
        });
        status = "BLOCKED";
        severity = "high";
        requiredAction = "Reject corrupted packet and request clean payload re-transmission.";
      } else if (isProhibited || key === "policy_coverage_limit" || key === "original_claim_amount" || key === "deductible") {
        const issueMsg = `Data Manipulation: '${key}' was modified from ${JSON.stringify(origVal)} to ${JSON.stringify(recVal)} without authorization.`;
        issues.push(issueMsg);
        fieldComparisons.push({
          field: key,
          originalValue: origVal,
          receivedValue: recVal,
          changeType: "modified",
          isAuthorized: false,
          status: "fail",
          detail: `Unauthorized modification violates contract for ${sourceContract.code}`
        });
        status = "BLOCKED";
        severity = "critical";
        requiredAction = `Block unauthorized mutation. Rollback '${key}' to baseline verified value.`;
      } else {
        fieldComparisons.push({
          field: key,
          originalValue: origVal,
          receivedValue: recVal,
          changeType: "modified",
          isAuthorized: true,
          status: "pass",
          detail: "Permitted state transformation"
        });
      }
    }
  }
  if (receivedPayload.reported_damage && sourcePayload.reported_damage) {
    const srcDmg = String(sourcePayload.reported_damage).toLowerCase();
    const recDmg = String(receivedPayload.reported_damage).toLowerCase();
    if (srcDmg.includes("front") && recDmg.includes("rear") && !srcDmg.includes("rear")) {
      issues.push(`Semantic Inconsistency: Source reported front damage ("${sourcePayload.reported_damage}"), but received payload asserts rear damage ("${receivedPayload.reported_damage}").`);
      status = "HUMAN_REVIEW";
      severity = "high";
      requiredAction = "Hold claim for human adjuster review due to conflicting damage claims.";
    }
  }
  if (receivedPayload.policy_status && sourcePayload.policy_status) {
    if (sourcePayload.policy_status === "Expired" && receivedPayload.policy_status === "Active") {
      issues.push("Semantic Inconsistency: Policy status changed from Expired to Active across handoff.");
      status = "BLOCKED";
      severity = "critical";
      requiredAction = "Block handoff. Policy expiration verified in master registry cannot be bypassed.";
    }
  }
  let recalculation = void 0;
  if (handoffId === "C_TO_D" || handoffId === "D_TO_E") {
    const repairCost = Number(receivedPayload.estimated_repair_cost ?? receivedPayload.original_claim_amount ?? 0);
    const deductible = Number(receivedPayload.deductible ?? 0);
    const limit = Number(receivedPayload.policy_coverage_limit ?? 1e5);
    const actualEligible = Number(receivedPayload.calculated_eligible_amount ?? receivedPayload.expected_eligible_amount ?? 0);
    const expectedEligible = Math.min(limit, Math.max(0, repairCost - deductible));
    if (actualEligible !== expectedEligible && actualEligible > 0) {
      const diff = actualEligible - expectedEligible;
      recalculation = {
        expected: expectedEligible,
        actual: actualEligible,
        formula: `Min(Coverage Limit \u20B9${limit}, Repair Cost \u20B9${repairCost} - Deductible \u20B9${deductible})`,
        difference: diff
      };
      issues.push(`Incorrect Calculation: Claim eligible amount calculated as \u20B9${actualEligible}, but independent audit expects \u20B9${expectedEligible} (Difference: \u20B9${Math.abs(diff)}).`);
      status = "BLOCKED";
      severity = "high";
      requiredAction = `Flag arithmetic discrepancy. Enforce verified recalculation of \u20B9${expectedEligible}.`;
    }
  }
  if (destVersion < sourceVersion) {
    issues.push(`Stale / Out-of-Order: Received payload version v${destVersion} is older than source v${sourceVersion}.`);
    status = "WARNING";
    severity = "warning";
    requiredAction = "Quarantine stale packet and request latest sequence state.";
  }
  if (receivedPayload.is_duplicate_replay) {
    issues.push(`Duplicate or Replay: Message ID ${messageId} was previously processed at checkpoint.`);
    status = "WARNING";
    severity = "warning";
    requiredAction = "Replay handling policy: Deduplicate message and confirm idempotent state.";
  }
  if (handoffId === "D_TO_E") {
    const riskScore = Number(receivedPayload.risk_score ?? 0);
    const evidenceList = receivedPayload.evidence_package || receivedPayload.risk_factors || [];
    if (riskScore >= 70 && (!Array.isArray(evidenceList) || evidenceList.length === 0)) {
      issues.push(`Misleading / Unsupported Output: Agent D assigned a high risk score (${riskScore}/100) with zero corroborated evidence entries.`);
      status = "HUMAN_REVIEW";
      severity = "high";
      requiredAction = "Route to Senior Adjuster for Human Review. Automatic rejection prohibited without evidence.";
    }
  }
  if (!hashMatch && issues.length === 0) {
    status = "VERIFIED";
    severity = "info";
    requiredAction = "Payload verified. Authorized enrichments confirmed against contract.";
  }
  return {
    handoffId,
    sourceAgent,
    destAgent,
    claimId,
    messageId,
    sourceVersion,
    destVersion,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    status,
    severity,
    issues,
    fieldComparisons,
    sourceHash,
    receivedHash,
    hashMatch,
    requiredAction,
    auditEventId: `EV-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
    recalculation,
    isRecovered: isRetryAttempt
  };
}
export {
  runTrustMeshVerification
};
