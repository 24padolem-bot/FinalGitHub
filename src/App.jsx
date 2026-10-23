import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { AgentPipelineView } from './components/AgentPipelineView';
import { HandoffInspectorView } from './components/HandoffInspectorView';
import { ScenarioLabView } from './components/ScenarioLabView';
import { DatasetLabView } from './components/DatasetLabView';
import { AuditTrailView } from './components/AuditTrailView';
import { TrustAnalyticsView } from './components/TrustAnalyticsView';
import { JudgeDemoMode } from './components/JudgeDemoMode';

import { INITIAL_CLAIMS } from './data/initialClaims';
import {
  DETERMINISTIC_TEST_CASES,
  generateProcedureScenario,
  bindScenarioToClaim,
} from './data/testCases';
import {
  buildAgentAPayload,
  buildAgentBPayload,
  buildAgentCPayload,
  buildAgentDPayload,
  executeHandoffStep,
  buildFinalDecision,
} from './engine/agentSimulator';
import {
  loadAuditEventsFromStorage,
  saveAuditEventsToStorage,
  createAuditEventsFromVerification,
  createAuditEvent,
} from './engine/auditTrail';

import {
  ROTATION_SCHEDULE,
  getRotationStep,
  getRotationTestCaseForClaim,
} from './data/rotationSchedule';

const CLAIMS_STORAGE_KEY = 'trustmesh_claims_dataset_v1';
const SELECTED_CLAIM_KEY = 'trustmesh_selected_claim_id';

export default function App() {
  // Navigation State - Defaults to 'pipeline' so the 5 agents appear on the 1st interface
  const [activeTab, setActiveTab] = useState('pipeline');
  const [isJudgeDemoOpen, setIsJudgeDemoOpen] = useState(false);

  // Scenario Rotation State - Clean compliant pass as default
  const [rotationIndex, setRotationIndex] = useState(1);
  const [autoCycleScenarios, setAutoCycleScenarios] = useState(false);

  // Selected Claim ID State (strictly user-controlled, preserved across runs, scenarios & page reloads)
  const [selectedClaimId, setSelectedClaimId] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem(SELECTED_CLAIM_KEY);
        if (stored) return stored;
      }
    } catch (e) {
      console.error('Failed to load selected claim', e);
    }
    return 'CLM-2026-001';
  });

  // Claims Dataset State
  const [claims, setClaims] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem(CLAIMS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      }
    } catch (e) {
      console.error('Failed to load claims from storage', e);
    }
    return INITIAL_CLAIMS;
  });

  // Derived Active Claim from selectedClaimId - single source of truth for all agents!
  const activeClaim = claims.find(c => c.claim_id === selectedClaimId) || claims[0];

  // Test Cases State - Default to Clean Compliant Pass (null)
  const [testCases, setTestCases] = useState(DETERMINISTIC_TEST_CASES);
  const [activeTestCase, setActiveTestCase] = useState(null);

  // Audit Ledger State
  const [auditEvents, setAuditEvents] = useState(() => {
    return loadAuditEventsFromStorage();
  });

  // Handoff Selection State
  const [inspectedHandoff, setInspectedHandoff] = useState('A_TO_B');

  // Simulation Execution State
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [activeHandoffIndex, setActiveHandoffIndex] = useState(-1);
  const [totalTestsRun, setTotalTestsRun] = useState(1);

  const [handoffResults, setHandoffResults] = useState({
    A_TO_B: null,
    B_TO_C: null,
    C_TO_D: null,
    D_TO_E: null,
  });

  const [outgoingPayloads, setOutgoingPayloads] = useState({
    A_TO_B: null,
    B_TO_C: null,
    C_TO_D: null,
    D_TO_E: null,
  });

  const [incomingPayloads, setIncomingPayloads] = useState({
    A_TO_B: null,
    B_TO_C: null,
    C_TO_D: null,
    D_TO_E: null,
  });

  const [finalDecision, setFinalDecision] = useState(null);
  const [benchmarkResults, setBenchmarkResults] = useState(null);

  // Save claims & audit events to localStorage
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(claims));
      }
    } catch (e) {
      console.error('Failed to save claims', e);
    }
  }, [claims]);

  useEffect(() => {
    saveAuditEventsToStorage(auditEvents);
  }, [auditEvents]);

  // Persist selectedClaimId to localStorage
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(SELECTED_CLAIM_KEY, selectedClaimId);
      }
    } catch (e) {
      console.error('Failed to save selected claim', e);
    }
  }, [selectedClaimId]);

  // Explicit Claim Selection Handler
  const handleSelectClaim = (claim) => {
    if (isRunning) return;
    setSelectedClaimId(claim.claim_id);
    handleResetSimulation();
    if (activeTestCase) {
      setActiveTestCase(bindScenarioToClaim(activeTestCase, claim));
    }
  };

  // Explicit Test Case Selection Handler
  const handleSelectTestCase = (tc) => {
    if (tc) {
      setActiveTestCase(bindScenarioToClaim(tc, activeClaim));
    } else {
      setActiveTestCase(null);
    }
    handleResetSimulation();
  };

  // Timer Ref for simulation playback
  const simTimerRef = useRef(null);
  const handoffsOrder = ['A_TO_B', 'B_TO_C', 'C_TO_D', 'D_TO_E'];

  // Simulation execution engine
  const executeSimulationStep = (
    stepIdx,
    currentOutgoingPayloads,
    currentHandoffResults,
    claimToUse = activeClaim,
    testCaseToUse = activeTestCase
  ) => {
    const handoffId = handoffsOrder[stepIdx];

    let srcPayload;
    if (stepIdx === 0) {
      srcPayload = buildAgentAPayload(claimToUse);
    } else if (stepIdx === 1) {
      srcPayload = buildAgentBPayload(currentOutgoingPayloads['A_TO_B'], claimToUse);
    } else if (stepIdx === 2) {
      srcPayload = buildAgentCPayload(currentOutgoingPayloads['B_TO_C'], claimToUse);
    } else {
      srcPayload = buildAgentDPayload(currentOutgoingPayloads['C_TO_D'], claimToUse);
    }

    const { outgoing, incoming, result } = executeHandoffStep(
      handoffId,
      srcPayload,
      testCaseToUse,
      claimToUse
    );

    const updatedOutgoing = { ...currentOutgoingPayloads, [handoffId]: outgoing };
    const updatedIncoming = { ...incomingPayloads, [handoffId]: incoming };
    const updatedResults = { ...currentHandoffResults, [handoffId]: result };

    setOutgoingPayloads(updatedOutgoing);
    setIncomingPayloads(updatedIncoming);
    setHandoffResults(updatedResults);
    setActiveHandoffIndex(stepIdx);
    setInspectedHandoff(handoffId);

    // Append audit events
    setAuditEvents(prev => {
      const newEvs = createAuditEventsFromVerification(result, claimToUse, testCaseToUse, prev);
      return [...prev, ...newEvs];
    });

    // Check if blocked or needs human review halt
    if (result.status === 'BLOCKED') {
      setIsRunning(false);
      setIsCompleted(true);
      const dec = buildFinalDecision(claimToUse, updatedResults, incoming);
      setFinalDecision(dec);
      setTotalTestsRun(c => c + 1);
      return;
    }

    // Check if last step finished
    if (stepIdx === 3) {
      setIsRunning(false);
      setIsCompleted(true);
      const dec = buildFinalDecision(claimToUse, updatedResults, incoming);
      setFinalDecision(dec);
      setTotalTestsRun(c => c + 1);
      return;
    }

    // Continue to next step after delay if running and not paused
    simTimerRef.current = setTimeout(() => {
      executeSimulationStep(stepIdx + 1, updatedOutgoing, updatedResults, claimToUse, testCaseToUse);
    }, 1100);
  };

  const handleRunSimulation = () => {
    if (simTimerRef.current) clearTimeout(simTimerRef.current);

    const claimForThisRun = activeClaim;
    let testCaseForThisRun = activeTestCase;

    if (autoCycleScenarios) {
      const stepInfo = getRotationStep(rotationIndex);
      testCaseForThisRun = getRotationTestCaseForClaim(stepInfo, claimForThisRun, testCases);
      setActiveTestCase(testCaseForThisRun);
      setRotationIndex(prev => prev + 1);
    } else if (testCaseForThisRun) {
      testCaseForThisRun = bindScenarioToClaim(testCaseForThisRun, claimForThisRun);
      setActiveTestCase(testCaseForThisRun);
    }

    // Reset current run
    setIsRunning(true);
    setIsPaused(false);
    setIsCompleted(false);
    setActiveHandoffIndex(0);
    setFinalDecision(null);

    const emptyResults = { A_TO_B: null, B_TO_C: null, C_TO_D: null, D_TO_E: null };
    const emptyPayloads = { A_TO_B: null, B_TO_C: null, C_TO_D: null, D_TO_E: null };
    setHandoffResults(emptyResults);
    setOutgoingPayloads(emptyPayloads);
    setIncomingPayloads(emptyPayloads);

    // Record simulation start event
    setAuditEvents(prev => [
      ...prev,
      createAuditEvent(
        {
          claimId: claimForThisRun.claim_id,
          testCaseId: testCaseForThisRun?.id,
          sourceAgent: 'agent_a',
          destAgent: 'agent_b',
          eventType: 'SIMULATION_STARTED',
          severity: 'info',
          status: 'INITIATED',
          reason: `Dispatched ${claimForThisRun.customer_name}'s claim (${claimForThisRun.claim_id}, ₹${claimForThisRun.estimated_repair_cost.toLocaleString('en-IN')}) through 5-agent pipeline. Scenario: ${testCaseForThisRun?.name || 'Clean Compliant Pass'}.`,
          actionTaken: 'Began inter-agent verification.',
        },
        prev
      ),
    ]);

    // Start with Step 0
    executeSimulationStep(0, emptyPayloads, emptyResults, claimForThisRun, testCaseForThisRun);
  };

  const handleStepForward = () => {
    if (isCompleted) return;
    const nextIdx = activeHandoffIndex + 1;
    if (nextIdx > 3) return;

    if (simTimerRef.current) clearTimeout(simTimerRef.current);
    setIsPaused(true);
    executeSimulationStep(nextIdx, outgoingPayloads, handoffResults, activeClaim, activeTestCase);
  };

  const handlePause = () => {
    if (simTimerRef.current) clearTimeout(simTimerRef.current);
    setIsPaused(true);
  };

  const handleResume = () => {
    setIsPaused(false);
    const nextIdx = activeHandoffIndex + 1;
    if (nextIdx <= 3) {
      executeSimulationStep(nextIdx, outgoingPayloads, handoffResults, activeClaim, activeTestCase);
    }
  };

  const handleAdvanceScenario = () => {
    const nextIdx = rotationIndex + 1;
    setRotationIndex(nextIdx);
    const stepInfo = getRotationStep(nextIdx);
    const nextTestCase = getRotationTestCaseForClaim(stepInfo, activeClaim, testCases);
    setActiveTestCase(nextTestCase);
    handleResetSimulation();
  };

  const handleResetSimulation = () => {
    if (simTimerRef.current) clearTimeout(simTimerRef.current);
    setIsRunning(false);
    setIsPaused(false);
    setIsCompleted(false);
    setActiveHandoffIndex(-1);
    setFinalDecision(null);
    setHandoffResults({ A_TO_B: null, B_TO_C: null, C_TO_D: null, D_TO_E: null });
    setOutgoingPayloads({ A_TO_B: null, B_TO_C: null, C_TO_D: null, D_TO_E: null });
    setIncomingPayloads({ A_TO_B: null, B_TO_C: null, C_TO_D: null, D_TO_E: null });
  };

  // State Recovery simulation
  const handleSimulateRecovery = (handoffId) => {
    const srcPayload = outgoingPayloads[handoffId];
    if (!srcPayload) return;

    const { outgoing, incoming, result } = executeHandoffStep(
      handoffId,
      srcPayload,
      activeTestCase,
      activeClaim,
      { isRetry: true }
    );

    const updatedOutgoing = { ...outgoingPayloads, [handoffId]: outgoing };
    const updatedIncoming = { ...incomingPayloads, [handoffId]: incoming };
    const updatedResults = { ...handoffResults, [handoffId]: result };

    setOutgoingPayloads(updatedOutgoing);
    setIncomingPayloads(updatedIncoming);
    setHandoffResults(updatedResults);

    setAuditEvents(prev => {
      const newEvs = createAuditEventsFromVerification(result, activeClaim, activeTestCase, prev);
      return [...prev, ...newEvs];
    });

    const nextIdx = handoffsOrder.indexOf(handoffId) + 1;
    if (nextIdx <= 3) {
      setIsRunning(true);
      executeSimulationStep(nextIdx, updatedOutgoing, updatedResults);
    } else {
      setIsCompleted(true);
      const dec = buildFinalDecision(activeClaim, updatedResults, incoming);
      setFinalDecision(dec);
    }
  };

  // Scenario Generation Handlers
  const handleGenerateRandomScenario = () => {
    const newCase = generateProcedureScenario(activeClaim);
    setTestCases(prev => [newCase, ...prev]);
    setActiveTestCase(newCase);
    handleResetSimulation();
  };

  const handleGenerateBatch = () => {
    const newCases = [];
    for (let i = 0; i < 10; i++) {
      const claimToUse = claims[i % claims.length];
      newCases.push(generateProcedureScenario(claimToUse));
    }
    setTestCases(prev => [...newCases, ...prev]);
  };

  const handleRunBenchmark = () => {
    const results = {};
    for (const tc of testCases) {
      const srcPayload = buildAgentAPayload(activeClaim);
      const stepRes = executeHandoffStep(tc.affectedHandoff, srcPayload, tc, activeClaim);
      const status = stepRes.result.status;
      results[tc.id] = {
        actualStatus: status,
        passedMatch: status === tc.expectedStatus || status === 'BLOCKED',
      };
    }
    setBenchmarkResults(results);
  };

  // Dataset Management Handlers
  const handleAddClaim = (claim) => {
    setClaims(prev => [claim, ...prev]);
    setSelectedClaimId(claim.claim_id);
  };

  const handleUpdateClaim = (claim) => {
    setClaims(prev => prev.map(c => (c.claim_id === claim.claim_id ? claim : c)));
  };

  const handleDeleteClaim = (claimId) => {
    if (claims.length <= 1) return;
    const remaining = claims.filter(c => c.claim_id !== claimId);
    setClaims(remaining);
    if (selectedClaimId === claimId && remaining.length > 0) {
      setSelectedClaimId(remaining[0].claim_id);
    }
  };

  const handleResetClaims = () => {
    setClaims(INITIAL_CLAIMS);
    setSelectedClaimId(INITIAL_CLAIMS[0].claim_id);
  };

  const handleGenerateRandomClaim = () => {
    const newId = `CLM-2026-${String(claims.length + 1).padStart(3, '0')}`;
    const names = ['Kavita Rao', 'Vikram Batra', 'Aparna Nair', 'Nikhil Joshi', 'Deepa Venkat'];
    const types = ['Motor Insurance', 'Health Insurance', 'Commercial Property'];
    const repair = Math.floor(25000 + Math.random() * 80000);
    const limit = 250000;
    const ded = 5000;

    const newClaim = {
      claim_id: newId,
      customer_name: names[Math.floor(Math.random() * names.length)],
      customer_id: `CUST-${Math.floor(1000 + Math.random() * 9000)}`,
      policy_number: `POL-${Math.floor(10000 + Math.random() * 90000)}`,
      insurance_type: types[Math.floor(Math.random() * types.length)],
      vehicle_number: 'MH02AB9912',
      incident_date: '2026-10-12',
      claim_submission_date: '2026-10-15',
      reported_damage: 'Front bumper & grill cosmetic damage',
      estimated_repair_cost: repair,
      policy_coverage_limit: limit,
      policy_status: 'Active',
      deductible: ded,
      previous_related_claims: 0,
      original_claim_amount: repair,
      expected_eligible_amount: Math.min(limit, repair - ded),
      initial_claim_status: 'Under Review',
      location: 'Nagpur, Maharashtra',
    };

    setClaims(prev => [newClaim, ...prev]);
    setSelectedClaimId(newClaim.claim_id);
  };

  const handleClearAuditHistory = () => {
    setAuditEvents([]);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem('trustmesh_audit_events_v1');
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Universal Top Header */}
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenJudgeDemo={() => setIsJudgeDemoOpen(true)}
        onQuickRun={handleRunSimulation}
        onReset={handleResetSimulation}
        isSimulating={isRunning}
        nextRunLabel={getRotationStep(rotationIndex).badge}
        runCount={rotationIndex}
      />

      {/* Main Viewport Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'pipeline' && (
          <AgentPipelineView
            claim={activeClaim}
            testCase={activeTestCase}
            onSelectClaim={handleSelectClaim}
            onSelectTestCase={handleSelectTestCase}
            allClaims={claims}
            allTestCases={testCases}
            isRunning={isRunning}
            isPaused={isPaused}
            isCompleted={isCompleted}
            activeHandoffIndex={activeHandoffIndex}
            handoffResults={handoffResults}
            outgoingPayloads={outgoingPayloads}
            incomingPayloads={incomingPayloads}
            finalDecision={finalDecision}
            onRunSimulation={handleRunSimulation}
            onPauseSimulation={handlePause}
            onResumeSimulation={handleResume}
            onStepForward={handleStepForward}
            onResetSimulation={handleResetSimulation}
            onGenerateRandomScenario={handleGenerateRandomScenario}
            onInspectHandoff={hId => {
              setInspectedHandoff(hId);
              setActiveTab('inspector');
            }}
            onSimulateRecovery={handleSimulateRecovery}
            autoCycleScenarios={autoCycleScenarios}
            onToggleAutoCycle={setAutoCycleScenarios}
            onAdvanceScenario={handleAdvanceScenario}
            rotationLabel={getRotationStep(rotationIndex).label}
            nextRotationLabel={getRotationStep(rotationIndex + 1).label}
            rotationNumber={rotationIndex}
            onNavigateTab={setActiveTab}
          />
        )}

        {activeTab === 'inspector' && (
          <HandoffInspectorView
            activeHandoff={inspectedHandoff}
            onSelectHandoff={setInspectedHandoff}
            handoffResults={handoffResults}
            outgoingPayloads={outgoingPayloads}
            incomingPayloads={incomingPayloads}
          />
        )}

        {activeTab === 'scenarios' && (
          <ScenarioLabView
            testCases={testCases}
            activeTestCase={activeTestCase}
            onSelectTestCase={handleSelectTestCase}
            onGenerateRandom={handleGenerateRandomScenario}
            onGenerateBatch={handleGenerateBatch}
            onRunBenchmark={handleRunBenchmark}
            activeClaim={activeClaim}
            benchmarkResults={benchmarkResults}
          />
        )}

        {activeTab === 'dataset' && (
          <DatasetLabView
            claims={claims}
            activeClaim={activeClaim}
            onSelectClaim={handleSelectClaim}
            onAddClaim={handleAddClaim}
            onUpdateClaim={handleUpdateClaim}
            onDeleteClaim={handleDeleteClaim}
            onResetClaims={handleResetClaims}
            onGenerateRandomClaim={handleGenerateRandomClaim}
            onGenerateScenarioFromClaim={c => {
              handleSelectClaim(c);
              const tc = generateProcedureScenario(c);
              setTestCases(prev => [tc, ...prev]);
              setActiveTestCase(tc);
              setActiveTab('pipeline');
            }}
          />
        )}

        {activeTab === 'audit' && (
          <AuditTrailView
            events={auditEvents}
            onClearAuditHistory={handleClearAuditHistory}
          />
        )}

        {activeTab === 'analytics' && (
          <TrustAnalyticsView
            events={auditEvents}
            handoffResults={handoffResults}
            totalTestsRun={totalTestsRun}
          />
        )}
      </main>

      {/* Judge Demo Guided Modal */}
      <JudgeDemoMode
        isOpen={isJudgeDemoOpen}
        onClose={() => setIsJudgeDemoOpen(false)}
        claim={activeClaim}
        testCase={activeTestCase}
        onSelectTestCase={handleSelectTestCase}
        onRunCleanDemo={() => {
          setActiveTestCase(null);
          handleRunSimulation();
        }}
        onRunErrorDemo={tc => {
          handleSelectTestCase(tc);
          handleRunSimulation();
        }}
        onSimulateRecovery={handleSimulateRecovery}
        handoffResults={handoffResults}
        finalDecision={finalDecision}
        onInspectHandoff={hId => {
          setInspectedHandoff(hId);
          setActiveTab('inspector');
        }}
      />

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-4 px-6 text-xs text-slate-500 flex flex-col sm:flex-row sm:items-center justify-between gap-2 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-400">TrustMesh</span>
          <span>·</span>
          <span>Multi-Agent AI Verification &amp; Audit Layer</span>
        </div>
        <div className="flex items-center gap-4 text-slate-500">
          <span>Engine: Python Core &amp; Deterministic Audit Pipeline</span>
          <span>·</span>
          <span>SHA-256 Canonical Checkpoints</span>
        </div>
      </footer>
    </div>
  );
}
