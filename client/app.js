// Copyright (C) Agilysys, Inc. All rights reserved.

// Folio RCA Tool — Frontend Logic
const API = '';

// ==================== Tab Navigation ====================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.panel).classList.add('active');
  });
});

// ==================== State ====================
let lastComparisonResult = null;
let lastFolioTransactions = null;
let lastCsvData = null;
let lastRawCsvRows = null; // raw MongoDB/CSV rows for deep reference analysis
let lastMongoQuery = null; // the actual MongoDB query that produced lastRawCsvRows


// Account Verification Modal State
let pendingAccountVerificationCallback = null;
let verifyAccountData = null;

// ==================== Helpers ====================
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
}

/**
 * Skip query approval and execute directly
 * 
 * @param {function} callback - Function to call with the query
 */
function skipQueryApproval(callback) {
   if (!callback) {
     toast('No pending query');
     return;
   }
   
   // Execute directly without approval
   callback(null);
}

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
   if (e.key === 'Escape') {
     const accountModal = document.getElementById('accountVerificationModal');
     if (accountModal && accountModal.style.display === 'flex') {
       cancelAccountVerification();
       return;
     }
   }
});

/**
 * Show account verification modal before executing mongo query
 * Includes transfer details validation if transfers are present
 * 
 * @param {object} accountInfo - Account information {propertyCode, chargePostingSeq, tenantId, propertyId, accountId, accountType, transferInfo}
 * @param {function} callback - Function to call on approval
 */
function showAccountVerification(accountInfo, callback) {
  verifyAccountData = accountInfo;
  pendingAccountVerificationCallback = callback;
  
  // Populate the verification modal fields
  document.getElementById('verifyPropertyCode').textContent = accountInfo.propertyCode || 'N/A';
  document.getElementById('verifyChargePostingSeq').textContent = String(accountInfo.chargePostingSequenceNumber || 'N/A');
  document.getElementById('verifyTenantId').textContent = accountInfo.tenantId || 'N/A';
  document.getElementById('verifyPropertyId').textContent = accountInfo.propertyId || 'N/A';
  document.getElementById('verifyAccountId').textContent = accountInfo.accountId || 'N/A';
  document.getElementById('verifyAccountType').textContent = accountInfo.accountType || 'N/A';
  
   // Clear any previous error messages
   document.getElementById('verifyErrorMsg').style.display = 'none';
   document.getElementById('verifyErrorMsg').textContent = '';
   
   // Show modal
   const modal = document.getElementById('accountVerificationModal');
   modal.style.display = 'flex';
}

/**
 * Close account verification modal
 */
function closeAccountVerification() {
  const modal = document.getElementById('accountVerificationModal');
  modal.style.display = 'none';
  verifyAccountData = null;
  pendingAccountVerificationCallback = null;
}

/** Called only when the user explicitly cancels (X button or Cancel button or Escape) */
function cancelAccountVerification() {
  closeAccountVerification();
  setRunBusy(false);
  setRunStatus('Cancelled — click Run Comparison to try again', 'err');
}

function approveAccountVerification() {
  if (!pendingAccountVerificationCallback) {
    toast('No pending account verification');
    return;
  }
  // Save refs before closeAccountVerification() nulls them
  const cb   = pendingAccountVerificationCallback;
  const data = verifyAccountData;
  closeAccountVerification();
  cb(data);
}

/**
 * Approve account verification and proceed with query
 */
// (defined above as approveAccountVerification with saved refs)

/**
 * Show error in account verification modal
 */
function showAccountVerificationError(errorMsg) {
  const errorEl = document.getElementById('verifyErrorMsg');
  errorEl.textContent = errorMsg;
  errorEl.style.display = 'block';
}

function copyText(elementId) {
  const el = document.getElementById(elementId);
  navigator.clipboard.writeText(el.textContent).then(() => toast('Copied!'));
}

let lastMergedPayload = null;
let lastDeepCorrectedPayload = null;

function copyMergedPayload() {
  if (!lastMergedPayload) { toast('No corrected payload available'); return; }
  navigator.clipboard.writeText(JSON.stringify(lastMergedPayload, null, 2)).then(() => toast('Corrected payload copied!'));
}

function copyDeepCorrectedPayload() {
  if (!lastDeepCorrectedPayload) { toast('No deep corrected payload available'); return; }
  navigator.clipboard.writeText(JSON.stringify(lastDeepCorrectedPayload, null, 2)).then(() => toast('Deep corrected payload copied!'));
}

/**
 * Apply the fixes identified by Deep Reference Analysis onto the given base payload.
 * Returns { corrected: [...], diffs: [...] }
 *
 * Fixes applied (in priority order per line):
 *  1. tax_exempt_violation → remove folioTransferDetails entirely
 *  2. mismatch             → update trnsfrFromLineItemNo to correctTrnsfrFromLineItemNo
 */
function applyDeepAnalysisCorrections(basePayload, transferVerifications) {
  const corrected = JSON.parse(JSON.stringify(basePayload)); // deep clone
  const diffs = [];

  for (const folio of corrected) {
    if (!Array.isArray(folio.folioTransactionDetails)) continue;

    for (const txn of folio.folioTransactionDetails) {
      const lin = String(txn.lineItemNo).padStart(10, '0');

      // Collect all verifications for this lineItemNo
      const verifs = (transferVerifications || []).filter(
        v => String(v.lineItemNo).padStart(10, '0') === lin
      );
      if (verifs.length === 0) continue;

      // ── Fix 1: tax_exempt_violation — remove folioTransferDetails entirely ──
      if (verifs.some(v => v.status === 'tax_exempt_violation')) {
        if (txn.folioTransferDetails !== undefined) {
          const preview = JSON.stringify(txn.folioTransferDetails);
          diffs.push({
            lineItemNo: txn.lineItemNo,
            action: 'Removed folioTransferDetails',
            from: preview.length > 80 ? preview.substring(0, 80) + '…' : preview,
            to: 'null (removed)',
            reason: 'taxExemptDetail.taxExempted = true',
          });
          delete txn.folioTransferDetails;
        }
        continue; // no further fixes for this line
      }

      // ── Fix 2: mismatch — update trnsfrFromLineItemNo in each folioTransferDetails entry ──
      // Only correct entries where trnsfrFromLineItemNo actually exists; if it is absent
      // (null/undefined) that is expected behavior (e.g. sourceFolioLineItemId present).
      if (!Array.isArray(txn.folioTransferDetails)) continue;

      for (const detail of txn.folioTransferDetails) {
        // Skip entirely if trnsfrFromLineItemNo is absent — expected behavior, nothing to correct
        if (detail.trnsfrFromLineItemNo == null) continue;

        const existingVal = String(detail.trnsfrFromLineItemNo).trim();

        // Match by existingTrnsfrFromLineItemNo so we only update the right entry
        const matchingVerif = verifs.find(v =>
          v.status === 'mismatch' &&
          v.correctTrnsfrFromLineItemNo != null &&
          v.existingTrnsfrFromLineItemNo === existingVal
        );

        if (matchingVerif) {
          diffs.push({
            lineItemNo: txn.lineItemNo,
            action: 'Updated trnsfrFromLineItemNo',
            from: existingVal,
            to: matchingVerif.correctTrnsfrFromLineItemNo,
            reason: matchingVerif.resolution || 'Deep reference analysis',
          });
          detail.trnsfrFromLineItemNo = matchingVerif.correctTrnsfrFromLineItemNo;
        }
      }
    }
  }

  return { corrected, diffs };
}

function jsonParse(str) {
  try { return { data: JSON.parse(str), error: null }; }
  catch (e) { return { data: null, error: e.message }; }
}

function renderTable(headers, rows) {
  if (!rows.length) return '<p style="color:var(--subtext);font-size:0.85rem;">No items.</p>';
  let html = '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
  rows.forEach(row => {
    html += '<tr>' + row.map(cell => `<td>${cell ?? ''}</td>`).join('') + '</tr>';
  });
  return html + '</tbody></table>';
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${text}</span>`;
}

function showCodeTrace(lineItemNo) {
  const traces = window._codeTraces?.[lineItemNo];
  if (!traces?.length) return;
  const categoryColors = { transType: '#e8b931', amount: '#e07c5a', both: '#c084fc' };
  const categoryLabels = { transType: 'TransType', amount: 'Amount', both: 'Both' };
  let html = `<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)this.remove()">
    <div style="background:var(--card);border-radius:12px;padding:24px;max-width:800px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;color:var(--accent);">🔍 Code Path Analysis — lineItemNo: ${lineItemNo}</h3>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--subtext);cursor:pointer;font-size:1.2rem;">✕</button>
      </div>`;
  traces.forEach((t, i) => {
    html += `<div style="background:var(--bg);border-left:4px solid ${categoryColors[t.category]};border-radius:8px;padding:14px;margin-bottom:12px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="background:${categoryColors[t.category]};color:#000;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;">${categoryLabels[t.category]}</span>
        <code style="color:var(--accent);font-size:0.85rem;">${t.file} → ${t.method}()</code>
        <code style="color:var(--subtext);font-size:0.8rem;">line ${t.line}</code>
      </div>
      <p style="margin:0;color:var(--text);font-size:0.85rem;line-height:1.5;">${t.explanation}</p>
    </div>`;
  });
  html += '</div></div>';
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
}

// JSON validation on textarea
document.getElementById('folioJsonInput').addEventListener('input', function() {
  const el = document.getElementById('jsonValidation');
  if (!this.value.trim()) { el.innerHTML = ''; return; }
  const { error } = jsonParse(this.value);
  el.innerHTML = error
    ? `<div class="status status-err">❌ Invalid JSON: ${error}</div>`
    : `<div class="status status-ok">✅ Valid JSON</div>`;
});

// ==================== Comparison ====================
function setRunStatus(msg, type) {
  // type: 'info' | 'ok' | 'err'
  const el = document.getElementById('runStatus');
  if (!el) return;
  const colors = { info: 'var(--accent)', ok: 'var(--green)', err: 'var(--red)' };
  const icons  = { info: '⏳', ok: '✅', err: '❌' };
  el.innerHTML = msg
    ? `<span style="color:${colors[type]||colors.info}">${icons[type]||'⏳'} ${msg}</span>`
    : '';
}

function setRunBusy(busy) {
  const btn = document.getElementById('runComparisonBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? '⏳ Working…' : '▶ Run Comparison';
}

async function runComparison() {
  const fileInput = document.getElementById('csvFile');
  const jsonInput = document.getElementById('folioJsonInput').value.trim();

  if (!jsonInput) { setRunStatus('Please paste folioTransactions JSON first', 'err'); return; }
  const { data: folioTransactions, error } = jsonParse(jsonInput);
  if (error) { setRunStatus('Invalid JSON: ' + error, 'err'); return; }

  lastFolioTransactions = folioTransactions;
  setRunStatus('', '');

  let body;
  let useFormData = false;

  if (fileInput.files.length > 0) {
    const formData = new FormData();
    formData.append('csv', fileInput.files[0]);
    formData.append('folioTransactions', jsonInput);
    body = formData;
    useFormData = true;
    // CSV path — run comparison directly
    setRunBusy(true);
    setRunStatus('Running comparison with uploaded CSV…', 'info');
    try {
      const res = await fetch(`${API}/api/compare`, {
        method: 'POST', body,
      });
      const result = await res.json();
      if (result.error) { setRunStatus('Error: ' + result.error, 'err'); return; }
      lastComparisonResult = result;
      lastCsvData = result;
      if (Array.isArray(result._csvRows)) lastRawCsvRows = result._csvRows;
      setRunStatus('Comparison complete', 'ok');
      renderComparisonResults(result);
      document.querySelector('[data-panel="comparison"]').click();
    } catch (e) {
      setRunStatus('Request failed: ' + e.message, 'err');
    } finally {
      setRunBusy(false);
    }
    return;
  }

  // ── No CSV: verify → modal approval → fetch mongo → compare ──
  setRunBusy(true);
  setRunStatus('Step 1/3 — Verifying account (looking up MongoDB)…', 'info');

  try {
    const verifyRes = await fetch(`${API}/api/verify-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions })
    });

    let verifyData;
    try {
      verifyData = await verifyRes.json();
    } catch (e) {
      setRunStatus('Server returned non-JSON response (is the server running on port 3999?)', 'err');
      setRunBusy(false);
      return;
    }

    if (verifyData.error) {
      setRunStatus('Verification failed: ' + verifyData.error, 'err');
      // Also show in the modal so the user can read the detail
      document.getElementById('verifyPropertyCode').textContent = 'N/A';
      document.getElementById('verifyChargePostingSeq').textContent = 'N/A';
      document.getElementById('verifyTenantId').textContent = 'N/A';
      document.getElementById('verifyPropertyId').textContent = 'N/A';
      document.getElementById('verifyAccountId').textContent = 'N/A';
      document.getElementById('verifyAccountType').textContent = 'N/A';
      showAccountVerificationError(verifyData.error);
      document.getElementById('accountVerificationModal').style.display = 'flex';
      setRunBusy(false);
      return;
    }

    setRunStatus('Step 2/3 — Account found. Confirm details in the modal…', 'info');

    // Show verification modal; execution continues inside callback on user approval
    showAccountVerification(verifyData, async () => {
      setRunStatus('Step 3/3 — Fetching ledger data from MongoDB…', 'info');
      try {
        const mongoRes = await fetch(`${API}/api/execute-mongo-query`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folioTransactions })
        });

        let mongoData;
        try {
          mongoData = await mongoRes.json();
        } catch (e) {
          setRunStatus('MongoDB endpoint returned non-JSON (server error)', 'err');
          setRunBusy(false);
          return;
        }

        if (mongoData.error) {
          setRunStatus('MongoDB error: ' + mongoData.error, 'err');
          setRunBusy(false);
          return;
        }

        lastCsvData = mongoData.rows;
        lastRawCsvRows = mongoData.rows;
        if (mongoData.mongoQuery) lastMongoQuery = mongoData.mongoQuery;
        // Store tenantId/propertyId so transfer reference query can use them
        window._lastMongoMeta = { tenantId: mongoData.tenantId, propertyId: mongoData.propertyId };
        setRunStatus(`Fetched ${mongoData.rowCount} rows — running comparison…`, 'info');

        const compRes = await fetch(`${API}/api/compare`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvData: mongoData.rows, folioTransactions })
        });
        const result = await compRes.json();
        if (result.error) { setRunStatus('Compare error: ' + result.error, 'err'); setRunBusy(false); return; }

        lastComparisonResult = result;
        lastCsvData = result;
        setRunStatus('Done — ' + (result.matched || 0) + ' matched, ' + (result.missing?.length || 0) + ' missing', 'ok');
        renderComparisonResults(result);
        document.querySelector('[data-panel="comparison"]').click();
      } catch (e) {
        setRunStatus('Execution error: ' + e.message, 'err');
      } finally {
        setRunBusy(false);
      }
    });


  } catch (e) {
    setRunStatus('Network error: ' + e.message + ' (is the server running?)', 'err');
    setRunBusy(false);
  }
}

function renderComparisonResults(r) {
  // Summary
  document.getElementById('compSummary').innerHTML = `
    <div class="summary-grid">
      <div class="summary-item"><div class="num">${r.totalCsvRows}</div><div class="lbl">CSV Rows</div></div>
      <div class="summary-item"><div class="num">${r.totalTransactions}</div><div class="lbl">Payload Txns</div></div>
      <div class="summary-item"><div class="num" style="color:var(--green)">${r.matched}</div><div class="lbl">Matched</div></div>
      <div class="summary-item"><div class="num" style="color:var(--red)">${r.missing.length}</div><div class="lbl">Missing</div></div>
      <div class="summary-item"><div class="num" style="color:var(--peach)">${r.extra.length}</div><div class="lbl">Extra</div></div>
      <div class="summary-item"><div class="num" style="color:var(--yellow)">${r.mismatches.length}</div><div class="lbl">Mismatches</div></div>
     </div>`;

   // Balance
  document.getElementById('balanceTable').innerHTML = renderTable(
    ['Folio ID', 'Window', 'NEW Total', 'SET Total', 'Balanced'],
    r.balanceSummary.map(b => [b.folioId, b.windowId, b.newTotal, b.setTotal,
      b.isBalanced ? badge('✓', 'green') : badge('OOB', 'red')])
  );

  // Missing
  document.getElementById('missingBadge').innerHTML = r.missing.length ? badge(r.missing.length, 'red') : badge('0', 'green');
  document.getElementById('missingTable').innerHTML = renderTable(
    ['lineItemNo', 'Ledger Txn ID', 'type', 'totalAmount', 'originalType', 'sourceAccountType', 'destinationAccountType'],
    r.missing.map(m => [m.lineItemNo, m.csvRow.transactionId || m.csvRow._id || '-', m.csvRow.type, m.csvRow.totalAmount, m.csvRow.originalType, m.csvRow.sourceAccountType, m.csvRow.destinationAccountType])
  );

  // Show/hide resolve missing section + pre-fill graph query
  const resolveSection = document.getElementById('resolveMissingSection');
  if (r.missing.length > 0) {
    resolveSection.style.display = 'block';
    // Store missing lineItemNos and csvRows for later
    window._missingLineItemNos = r.missing.map(m => m.lineItemNo);
    window._lastCsvRows = r._csvRows || null; // server may send back csvRows

    // Pre-fill graph query from input fields
    const acctType = document.getElementById('accountType').value;
    const confNum = document.getElementById('confirmationNumber').value;
    const folioNum = document.getElementById('folioNumber').value;
    const houseNum = document.getElementById('houseAccountNumber').value;
    const propId = document.getElementById('propertyId').value;

    // Auto-extract from folioTransactions if fields are empty
    if (lastFolioTransactions?.length) {
      const fid = lastFolioTransactions[0].folioId || '';
      if (!propId) document.getElementById('propertyId').value = fid.split('_')[0] || '';
      if (!folioNum) document.getElementById('folioNumber').value = lastFolioTransactions[0].folioNumber || '';
      const confIds = lastFolioTransactions[0].confirmationIds || [];
      const acrsConf = confIds.find(c => c.provider === 'ACRS');
      if (!confNum && acrsConf) document.getElementById('confirmationNumber').value = acrsConf.value || '';
    }

    // Fetch the graph query
    fetchResendQueryForMissing();
  } else {
    resolveSection.style.display = 'none';
  }

  // Extra
  document.getElementById('extraBadge').innerHTML = r.extra.length ? badge(r.extra.length, 'peach') : badge('0', 'green');
  document.getElementById('extraTable').innerHTML = renderTable(
    ['lineItemNo', 'transType', 'Amount'],
    r.extra.map(e => [e.lineItemNo, e.transaction.transType, e.transaction.transactionAmt?.value])
  );

  // Mismatches
  document.getElementById('mismatchBadge').innerHTML = r.mismatches.length ? badge(r.mismatches.length, 'yellow') : badge('0', 'green');
  document.getElementById('mismatchTable').innerHTML = renderTable(
    ['lineItemNo', 'Ledger Txn ID', 'CSV Type', 'Rule', 'Expected transType', 'Actual transType', 'Expected Amount', 'Actual Amount', 'Code Analysis'],
    r.mismatches.map(m => [m.lineItemNo, m.csvRow.transactionId || m.csvRow._id || '-', m.csvRow.type, m.ruleResult.rule,
      m.ruleResult.expected.transType, m.ruleResult.actual.transType,
      m.ruleResult.expected.amount, m.ruleResult.actual.amount,
      m.ruleResult.codeTraces?.length ? `<button class="btn btn-sm" onclick="showCodeTrace('${m.lineItemNo}')">🔍 View</button>` : '-'])
  );

  // Store code traces for popup display
  window._codeTraces = {};
  r.mismatches.forEach(m => {
    if (m.ruleResult.codeTraces?.length) {
      window._codeTraces[m.lineItemNo] = m.ruleResult.codeTraces;
    }
  });

  // PKG
  document.getElementById('pkgTable').innerHTML = renderTable(
    ['lineItemNo', 'Correct', 'Expected Amount', 'Actual Amount', 'Linked Count'],
    r.pkgValidations.map(p => [p.lineItemNo,
      p.isCorrect ? badge('✓', 'green') : badge('✗', 'red'),
      p.expectedAmount, p.actualAmount, p.linkedCount])
  );

  // Auto-Correction (inline from comparison response)
  if (r.correction) {
    const diffs = r.correction.diffs || [];
    document.getElementById('correctionBadge').innerHTML = diffs.length ? badge(diffs.length + ' diffs', 'yellow') : badge('0 diffs', 'green');
    document.getElementById('diffTable').innerHTML = renderTable(
      ['lineItemNo', 'Field', 'Original', 'Corrected'],
      diffs.map(d => [d.lineItemNo, d.field,
        `<span style="color:var(--red)">${d.original}</span>`,
        `<span style="color:var(--green)">${d.corrected}</span>`])
    );

    if (diffs.length > 0) {
      // Show JSON comparator and corrected payload only if there are actual diffs
      document.getElementById('jsonComparator').innerHTML =
        renderJsonComparator(lastFolioTransactions, r.correction.correctedPayload);
      syncJsonComparatorScroll();
      setTimeout(() => { if (jcDiffLines.length) jcJumpTo(0); }, 100);

      document.getElementById('correctedPayloadCard').style.display = 'block';
      lastMergedPayload = r.correction.correctedPayload;
      document.getElementById('correctedPayloadOutput').textContent =
        JSON.stringify(r.correction.correctedPayload, null, 2);

      // Compute NEW/SET totals for corrected payload
      document.getElementById('correctedBalanceSummary').innerHTML = computeBalanceSummaryHtml(r.correction.correctedPayload);
    } else {
      document.getElementById('jsonComparator').innerHTML = '<p style="color:var(--green);text-align:center;padding:1rem;">✅ No differences — payload is correct as-is.</p>';
      document.getElementById('correctedPayloadCard').style.display = 'none';
    }
  } else {
    document.getElementById('correctionBadge').innerHTML = '';
    document.getElementById('diffTable').innerHTML = '<p style="color:var(--subtext)">No correction data.</p>';
    document.getElementById('jsonComparator').innerHTML = '';
    document.getElementById('correctedPayloadCard').style.display = 'none';
  }

  // Show the Deep Reference Analysis button after comparison completes
  const deepCard = document.getElementById('deepReferenceCard');
  if (deepCard) {
    deepCard.style.display = 'block';
    document.getElementById('deepReferenceStatus').innerHTML = '';
    document.getElementById('deepReferenceResults').innerHTML = '';
    // Populate the query display
    const queryEl = document.getElementById('deepRefMongoQuery');
    if (queryEl) {
      queryEl.textContent = lastMongoQuery || 'No MongoDB query available — comparison was run from a CSV upload, not MongoDB.';
    }
  }
}

// Helper: compute NEW/SET balance summary from folio payload
function computeBalanceSummaryHtml(folioPayload) {
  if (!Array.isArray(folioPayload)) return '';
  let html = '<div style="font-size:0.85rem;">';
  folioPayload.forEach(folio => {
    let newTotal = 0, setTotal = 0;
    (folio.folioTransactionDetails || []).forEach(txn => {
      if (txn.transType === 'NEW') newTotal += txn.transactionAmt?.value || 0;
      else if (txn.transType === 'SET') setTotal += txn.transactionAmt?.value || 0;
    });
    // Balanced when:
    //  (a) newTotal + setTotal ≈ 0 (charges and payments cancel — SET stored as negative), OR
    //  (b) newTotal === setTotal   (charges equal payments — both stored as positive values)
    const balanced = Math.abs(newTotal + setTotal) < 1 || Math.abs(newTotal - setTotal) < 1;
    html += `<div style="margin:0.2rem 0;">
      <strong>${folio.folioWindowId || folio.folioId || 'Folio'}</strong>:
      NEW = <span style="color:var(--green)">${newTotal}</span> |
      SET = <span style="color:var(--red)">${setTotal}</span> |
      ${balanced ? '<span style="color:var(--green)">✓ Balanced</span>' : '<span style="color:var(--red)">OOB (' + (newTotal + setTotal) + ')</span>'}
    </div>`;
  });
  html += '</div>';
  return html;
}

// ==================== Resolve Missing Transactions ====================
async function fetchResendQueryForMissing() {
  const body = {
    accountType: document.getElementById('accountType').value,
    confirmationNumber: document.getElementById('confirmationNumber').value,
    folioNumber: document.getElementById('folioNumber').value,
    houseAccountNumber: document.getElementById('houseAccountNumber').value,
    propertyId: document.getElementById('propertyId').value,
  };
  try {
    const res = await fetch(`${API}/api/resend-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    document.getElementById('missingGraphQuery').textContent = data.query || 'No query generated';
    document.getElementById('missingGraphVars').textContent = JSON.stringify(data.variables, null, 2);
  } catch (e) { console.error('Failed to fetch resend query for missing', e); }
}

async function resolveMissingTransactions() {
  const graphInput = document.getElementById('missingGraphResponse').value.trim();
  if (!graphInput) { toast('Paste the graph response JSON'); return; }
  const { data: graphResponse, error } = jsonParse(graphInput);
  if (error) { toast('Invalid JSON: ' + error); return; }

  const accountType = document.getElementById('accountType').value;
  const missingLineItemNos = window._missingLineItemNos || [];

  if (!lastFolioTransactions) { toast('No folioTransactions in memory'); return; }

  // Use stored CSV rows (from MongoDB fetch or file upload)
  const csvRows = Array.isArray(lastCsvData) ? lastCsvData : null;

  toast('Resolving missing transactions...');
  try {
    const res = await fetch(`${API}/api/resolve-missing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graphResponse,
        accountType,
        folioTransactions: lastFolioTransactions,
        missingLineItemNos,
        csvRows,
      })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }

    // Show result
    let html = `<div style="margin-top:0.5rem;">`;
    html += `<div class="status status-ok">✅ Resolved <strong>${data.resolvedCount}</strong> of ${missingLineItemNos.length} missing transactions (${data.totalConstructed} total from graph response)</div>`;

    if (data.allConstructedLineItemNos?.length) {
      html += `<details style="margin-top:0.3rem;font-size:0.8rem;"><summary style="cursor:pointer;color:var(--accent);">Graph response lineItemNos (${data.allConstructedLineItemNos.length})</summary>`;
      html += `<div style="max-height:150px;overflow:auto;padding:0.3rem;background:var(--bg);border-radius:4px;margin-top:0.3rem;font-family:var(--mono);font-size:0.75rem;">`;
      html += data.allConstructedLineItemNos.join('<br>');
      html += `</div></details>`;
    }

    if (data.resolvedCount < missingLineItemNos.length) {
      const resolvedSet = new Set(data.resolvedTransactions.map(t => String(t.lineItemNo).padStart(10, '0')));
      const stillMissing = missingLineItemNos.filter(n => !resolvedSet.has(String(n).padStart(10, '0')));
      html += `<div class="status status-err" style="margin-top:0.3rem;">⚠️ Still missing: ${stillMissing.join(', ')}</div>`;
    }

    if (data.graphStructure?.length) {
      html += `<details style="margin-top:0.3rem;font-size:0.8rem;"><summary style="cursor:pointer;color:var(--accent);">Debug: Graph Response Structure</summary>`;
      html += `<pre style="max-height:200px;overflow:auto;margin-top:0.3rem;font-size:0.7rem;">${data.graphStructure.join('\n')}</pre></details>`;
    }
    html += `</div>`;

    // Show mock warnings — fields that may be inaccurate
    if (data.mockWarnings?.length) {
      html += `<details style="margin-top:0.5rem;" open><summary style="cursor:pointer;color:#e2b340;font-weight:600;">⚠️ Fields that may be inaccurate (replicated/mocked logic)</summary>`;
      html += `<table style="width:100%;font-size:0.78rem;border-collapse:collapse;margin-top:0.3rem;">`;
      html += `<tr style="background:var(--bg);"><th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border);">Field</th><th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border);">Why it may be wrong</th><th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border);">Source</th></tr>`;
      for (const w of data.mockWarnings) {
        html += `<tr><td style="padding:4px 6px;border-bottom:1px solid var(--border);font-family:var(--mono);color:var(--accent);white-space:nowrap;">${w.field}</td><td style="padding:4px 6px;border-bottom:1px solid var(--border);">${w.reason}</td><td style="padding:4px 6px;border-bottom:1px solid var(--border);font-size:0.7rem;color:#888;white-space:nowrap;">${w.source}</td></tr>`;
      }
      html += `</table></details>`;
    }

    // Copy merged payload button
    html += `<button class="secondary" style="margin-top:0.5rem;" onclick="copyMergedPayload()">📋 Copy Corrected Payload</button>`;

    document.getElementById('resolveResult').innerHTML = html;

    // Update the corrected payload with the merged result
    const mergedPayload = data.mergedPayload;
    lastMergedPayload = mergedPayload;
    document.getElementById('correctedPayloadOutput').textContent = JSON.stringify(mergedPayload, null, 2);
    document.getElementById('correctedPayloadCard').style.display = 'block';
    document.getElementById('correctedBalanceSummary').innerHTML = computeBalanceSummaryHtml(mergedPayload);

    // Update JSON comparator
    document.getElementById('jsonComparator').innerHTML =
      renderJsonComparator(lastFolioTransactions, mergedPayload);
    syncJsonComparatorScroll();
    setTimeout(() => { if (jcDiffLines.length) jcJumpTo(0); }, 100);

    // Update correction diffs if available
    if (data.correction) {
      const diffs = data.correction.diffs || [];
      document.getElementById('correctionBadge').innerHTML = diffs.length ? badge(diffs.length + ' diffs', 'yellow') : badge('0 diffs', 'green');
      document.getElementById('diffTable').innerHTML = renderTable(
        ['lineItemNo', 'Field', 'Original', 'Corrected'],
        diffs.map(d => [d.lineItemNo, d.field,
          `<span style="color:var(--red)">${d.original}</span>`,
          `<span style="color:var(--green)">${d.corrected}</span>`])
      );
    }

    toast(`Resolved ${data.resolvedCount} missing transactions!`);
  } catch (e) { toast('Error: ' + e.message); }
}

// ==================== JSON Comparator ====================
// ── Myers diff algorithm ──
// O(d*(m+n)) time/space where d = number of edits. No large DP table → no OOM on big payloads.
function computeLineDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const offset = n; // diagonal k = x-y; index = k+offset to keep it non-negative
  const vSize = n + m + 2;
  let v = new Array(vSize).fill(0);
  const trace = []; // snapshots of v per edit-distance d

  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + offset;
      let x;
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
        x = v[ki + 1]; // down → insert from bLines
      } else {
        x = v[ki - 1] + 1; // right → delete from aLines
      }
      let y = x - k;
      while (x < n && y < m && aLines[x] === bLines[y]) { x++; y++; } // snake
      v[ki] = x;
      if (x >= n && y >= m) { found = true; break outer; }
    }
  }

  if (!found) {
    // Safety fallback (shouldn't happen): pair up lines, mark rest as inserts/deletes
    const ops = [];
    const len = Math.max(n, m);
    for (let i = 0; i < len; i++) {
      if (i < n && i < m) ops.push({ type: 'replace', leftLine: aLines[i], rightLine: bLines[i] });
      else if (i < n)      ops.push({ type: 'delete',  leftLine: aLines[i], rightLine: null });
      else                 ops.push({ type: 'insert',  leftLine: null,      rightLine: bLines[i] });
    }
    return ops;
  }

  // Back-trace through snapshots to reconstruct edit ops
  const rawOps = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const ki = k + offset;
    let prevK;
    if (k === -d || (k !== d && vd[ki - 1] < vd[ki + 1])) {
      prevK = k + 1; // came via insert (down)
    } else {
      prevK = k - 1; // came via delete (right)
    }
    const prevX = vd[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--; y--;
      rawOps.unshift({ type: 'equal', leftLine: aLines[x], rightLine: bLines[y] });
    }
    if (d > 0) {
      if (prevK === k + 1) { y--; rawOps.unshift({ type: 'insert', leftLine: null, rightLine: bLines[y] }); }
      else                  { x--; rawOps.unshift({ type: 'delete', leftLine: aLines[x], rightLine: null }); }
    }
    x = prevX; y = prevY;
  }

  // Merge adjacent delete+insert into 'replace'
  const merged = [];
  for (let i = 0; i < rawOps.length; i++) {
    if (rawOps[i].type === 'delete' && i + 1 < rawOps.length && rawOps[i + 1].type === 'insert') {
      merged.push({ type: 'replace', leftLine: rawOps[i].leftLine, rightLine: rawOps[i + 1].rightLine });
      i++;
    } else {
      merged.push(rawOps[i]);
    }
  }
  return merged;
}

// Build HTML for a side-by-side diff from an ops array.
// Returns { leftHtml, rightHtml, diffCount, diffIdxArray }
// diffIdxArray holds virtual row indices (sequential) of changed rows.
function buildDiffHtml(ops, esc) {
  let leftHtml = '', rightHtml = '', diffCount = 0;
  const diffRows = [];
  let row = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      leftHtml  += `<div class="jc-line" data-ln="${row}">${esc(op.leftLine)}</div>`;
      rightHtml += `<div class="jc-line" data-ln="${row}">${esc(op.rightLine)}</div>`;
    } else if (op.type === 'replace') {
      diffRows.push(row); diffCount++;
      leftHtml  += `<div class="jc-line jc-del" data-ln="${row}">${esc(op.leftLine)}</div>`;
      rightHtml += `<div class="jc-line jc-add" data-ln="${row}">${esc(op.rightLine)}</div>`;
    } else if (op.type === 'delete') {
      diffRows.push(row); diffCount++;
      leftHtml  += `<div class="jc-line jc-del" data-ln="${row}">${esc(op.leftLine)}</div>`;
      rightHtml += `<div class="jc-line" data-ln="${row}" style="opacity:0.3">` + esc('') + `</div>`;
    } else { // insert
      diffRows.push(row); diffCount++;
      leftHtml  += `<div class="jc-line" data-ln="${row}" style="opacity:0.3">` + esc('') + `</div>`;
      rightHtml += `<div class="jc-line jc-add" data-ln="${row}">${esc(op.rightLine)}</div>`;
    }
    row++;
  }
  return { leftHtml, rightHtml, diffCount, diffRows };
}

let jcDiffLines = [];   // indices of lines that differ
let jcDiffPos = -1;     // current position in jcDiffLines

function renderJsonComparator(original, corrected) {
  const origStr = JSON.stringify(original, null, 2);
  const corrStr = JSON.stringify(corrected, null, 2);
  const origLines = origStr.split('\n');
  const corrLines = corrStr.split('\n');

  jcDiffLines = [];
  jcDiffPos = -1;

  const esc = (s) => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const ops = computeLineDiff(origLines, corrLines);
  const { leftHtml, rightHtml, diffCount, diffRows } = buildDiffHtml(ops, esc);
  jcDiffLines = diffRows;

  const count = diffCount;
  return `
    <div class="jc-nav">
      <button class="jc-nav-btn" onclick="jcGoPrev()" title="Previous diff">▲ Prev</button>
      <span class="jc-nav-label" id="jcNavLabel">${count} diff${count !== 1 ? 's' : ''} found</span>
      <button class="jc-nav-btn" onclick="jcGoNext()" title="Next diff">▼ Next</button>
    </div>
    <div class="jc-wrap">
      <div class="jc-pane"><div class="jc-header">Original</div><div class="jc-code" id="jcLeft">${leftHtml}</div></div>
      <div class="jc-pane"><div class="jc-header" style="color:var(--green)">Corrected</div><div class="jc-code" id="jcRight">${rightHtml}</div></div>
    </div>`;
}

// ── Deep Analysis JSON Comparator (separate state to avoid conflicts with the main comparator) ──
let jcDeepDiffLines = [];
let jcDeepDiffPos = -1;

function renderDeepJsonComparator(original, corrected) {
  const origStr = JSON.stringify(original, null, 2);
  const corrStr = JSON.stringify(corrected, null, 2);
  const origLines = origStr.split('\n');
  const corrLines = corrStr.split('\n');

  jcDeepDiffLines = [];
  jcDeepDiffPos = -1;

  const esc = (s) => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const ops = computeLineDiff(origLines, corrLines);
  const { leftHtml, rightHtml, diffCount, diffRows } = buildDiffHtml(ops, esc);
  jcDeepDiffLines = diffRows;

  const count = diffCount;
  return `
    <div class="jc-nav">
      <button class="jc-nav-btn" onclick="jcDeepGoPrev()" title="Previous diff">▲ Prev</button>
      <span class="jc-nav-label" id="jcDeepNavLabel">${count} diff${count !== 1 ? 's' : ''} found</span>
      <button class="jc-nav-btn" onclick="jcDeepGoNext()" title="Next diff">▼ Next</button>
    </div>
    <div class="jc-wrap">
      <div class="jc-pane"><div class="jc-header">Original</div><div class="jc-code" id="jcDeepLeft">${leftHtml}</div></div>
      <div class="jc-pane"><div class="jc-header" style="color:var(--green)">Deep Corrected</div><div class="jc-code" id="jcDeepRight">${rightHtml}</div></div>
    </div>`;
}

function jcDeepJumpTo(idx) {
  if (!jcDeepDiffLines.length) return;
  jcDeepDiffPos = idx;
  const ln = jcDeepDiffLines[idx];
  document.querySelectorAll('#jcDeepLeft .jc-focus, #jcDeepRight .jc-focus').forEach(el => el.classList.remove('jc-focus'));
  ['jcDeepLeft', 'jcDeepRight'].forEach(id => {
    const pane = document.getElementById(id);
    if (!pane) return;
    const el = pane.querySelector('[data-ln="' + ln + '"]');
    if (!el) return;
    el.classList.add('jc-focus');
    let top = 0, node = el;
    while (node && node !== pane) { top += node.offsetTop; node = node.offsetParent; }
    pane.scrollTop = top - pane.clientHeight / 2 + el.clientHeight / 2;
  });
  const lbl = document.getElementById('jcDeepNavLabel');
  if (lbl) lbl.textContent = (idx + 1) + ' / ' + jcDeepDiffLines.length + ' diffs';
}

function jcDeepGoNext() {
  if (!jcDeepDiffLines.length) return;
  jcDeepJumpTo(jcDeepDiffPos + 1 >= jcDeepDiffLines.length ? 0 : jcDeepDiffPos + 1);
}

function jcDeepGoPrev() {
  if (!jcDeepDiffLines.length) return;
  jcDeepJumpTo(jcDeepDiffPos - 1 < 0 ? jcDeepDiffLines.length - 1 : jcDeepDiffPos - 1);
}

function jcJumpTo(idx) {
  if (!jcDiffLines.length) return;
  jcDiffPos = idx;
  const ln = jcDiffLines[idx];
  // clear old focus
  document.querySelectorAll('.jc-focus').forEach(el => el.classList.remove('jc-focus'));
  // highlight + scroll in both panes
  ['jcLeft','jcRight'].forEach(id => {
    const pane = document.getElementById(id);
    if (!pane) return;
    const el = pane.querySelector('[data-ln="' + ln + '"]');
    if (!el) return;
    el.classList.add('jc-focus');
    // Calculate offset relative to the pane's scroll container
    let top = 0;
    let node = el;
    while (node && node !== pane) {
      top += node.offsetTop;
      node = node.offsetParent;
    }
    pane.scrollTop = top - pane.clientHeight / 2 + el.clientHeight / 2;
  });
  document.getElementById('jcNavLabel').textContent =
    (idx + 1) + ' / ' + jcDiffLines.length + ' diffs';
}

function jcGoNext() {
  if (!jcDiffLines.length) return;
  jcJumpTo(jcDiffPos + 1 >= jcDiffLines.length ? 0 : jcDiffPos + 1);
}

function jcGoPrev() {
  if (!jcDiffLines.length) return;
  jcJumpTo(jcDiffPos - 1 < 0 ? jcDiffLines.length - 1 : jcDiffPos - 1);
}

// sync scroll for json comparator panes
function syncJsonComparatorScroll() {
  const left = document.getElementById('jcLeft');
  const right = document.getElementById('jcRight');
  if (!left || !right) return;
  left.onscroll = () => { right.scrollTop = left.scrollTop; right.scrollLeft = left.scrollLeft; };
  right.onscroll = () => { left.scrollTop = right.scrollTop; left.scrollLeft = right.scrollLeft; };
}

// ==================== Resend Query ====================
async function generateResendQuery() {
  const body = {
    accountType: document.getElementById('accountType').value,
    confirmationNumber: document.getElementById('confirmationNumber').value,
    folioNumber: document.getElementById('folioNumber').value,
    houseAccountNumber: document.getElementById('houseAccountNumber').value,
    propertyId: document.getElementById('propertyId').value,
  };
  try {
    const res = await fetch(`${API}/api/resend-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    document.getElementById('resendQueryOutput').textContent = data.query || 'No query generated';
    document.getElementById('resendVarsOutput').textContent = JSON.stringify(data.variables, null, 2);
  } catch (e) { toast('Error: ' + e.message); }
}

// ==================== Payload Construction ====================
async function constructPayload() {
  const input = document.getElementById('graphResponseInput').value.trim();
  if (!input) { toast('Paste graph response JSON'); return; }
  const { data: graphResponse, error } = jsonParse(input);
  if (error) { toast('Invalid JSON: ' + error); return; }

  try {
    const res = await fetch(`${API}/api/construct-payload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graphResponse, accountType: document.getElementById('accountType').value })
    });
    const data = await res.json();
    document.getElementById('payloadOutput').textContent = JSON.stringify(data.payload, null, 2);

    // Trace
    let traceHtml = '';
    if (data.codePathTrace?.length) {
      data.codePathTrace.forEach(t => {
        const color = t.action === 'excluded' ? 'var(--red)' : t.action === 'merged' ? 'var(--yellow)' : 'var(--green)';
        traceHtml += `<div style="margin:0.3rem 0;padding:0.3rem 0.6rem;border-left:3px solid ${color};font-size:0.8rem;">
          <strong>${t.transactionId}</strong> [${t.type}] → <span style="color:${color}">${t.action}</span>: ${t.reason} <em>(${t.step})</em></div>`;
      });
    }
    if (data.emptyFolios?.length) {
      traceHtml += `<div style="margin-top:0.5rem;color:var(--yellow)">Empty folios: ${data.emptyFolios.join(', ')}</div>`;
    }
    document.getElementById('traceOutput').innerHTML = traceHtml || '<p style="color:var(--subtext)">No trace entries.</p>';
  } catch (e) { toast('Error: ' + e.message); }
}


// ==================== Mongo Query Generator ====================
async function generateMongoQuery() {
  const jsonInput = document.getElementById('folioJsonInput').value.trim();
  if (!jsonInput) { toast('Please paste folioTransactions JSON in the Inputs tab first'); return; }
  const { data: folioTransactions, error } = jsonParse(jsonInput);
  if (error) { toast('Invalid JSON: ' + error); return; }

  const accountId = document.getElementById('mongoAccountId').value.trim();

  try {
    const res = await fetch(`${API}/api/generate-mongo-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions, accountId: accountId || undefined })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }

    // Show extracted info
    let infoHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.85rem;">`;
    infoHtml += `<div><strong>Property Code:</strong> ${data.propertyCode}</div>`;
    infoHtml += `<div><strong>Folio Number:</strong> ${data.folioNumber}</div>`;
    infoHtml += `<div><strong>Charge Posting Seq#:</strong> ${data.chargePostingSequenceNumber}</div>`;
    if (data.tenant) {
      infoHtml += `<div><strong>Tenant ID:</strong> ${data.tenant.tenantId}</div>`;
      infoHtml += `<div><strong>Property ID:</strong> ${data.tenant.propertyId}</div>`;
      infoHtml += `<div><strong>Region:</strong> ${data.tenant.region}</div>`;
      infoHtml += `<div><strong>Property Name:</strong> ${data.tenant.propertyName}</div>`;
    } else {
      infoHtml += `<div style="color:var(--yellow)">⚠️ Property "${data.propertyCode}" not found in tenantList.xlsx. Fill tenantId/propertyId manually in the query.</div>`;
    }
    infoHtml += `</div>`;
    document.getElementById('mongoExtractedInfo').innerHTML = infoHtml;

    // Show account lookup query
    document.getElementById('mongoAccountLookup').textContent = data.accountLookupQuery;

    // Show aggregation query
    document.getElementById('mongoAggQuery').textContent = data.mongoAggregationQuery;

  } catch (e) { toast('Error: ' + e.message); }
}

// Fetch ledger data from MongoDB directly and run comparison
// UPDATED: Now includes account verification modal as initial check
async function executeMongoQuery() {
  const jsonInput = document.getElementById('folioJsonInput').value.trim();
  if (!jsonInput) { toast('Please paste folioTransactions JSON in the Inputs tab first'); return; }
  
  const { data: folioTransactions, error } = jsonParse(jsonInput);
  if (error) { toast('Invalid JSON: ' + error); return; }
  
  // Validate that we have an array
  if (!Array.isArray(folioTransactions)) {
    toast('Error: JSON must be an array of folios, not ' + typeof folioTransactions);
    return;
  }
  
  if (folioTransactions.length === 0) {
    toast('Error: Array is empty. Paste at least one folio object.');
    return;
  }

  lastFolioTransactions = folioTransactions;
  
  // Step 1: Verify account information (NEW - initial modal check)
  try {
    toast('Verifying account information...');
    const verifyRes = await fetch(`${API}/api/verify-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions })
    });
    
    const verifyData = await verifyRes.json();
    if (verifyData.error) {
      toast('Error verifying account: ' + verifyData.error);
      // Show modal with error state
      document.getElementById('verifyPropertyCode').textContent = 'N/A';
      document.getElementById('verifyChargePostingSeq').textContent = 'N/A';
      document.getElementById('verifyTenantId').textContent = 'N/A';
      document.getElementById('verifyPropertyId').textContent = 'N/A';
      document.getElementById('verifyAccountId').textContent = 'N/A';
      document.getElementById('verifyAccountType').textContent = 'N/A';
      showAccountVerificationError(verifyData.error);
      const modal = document.getElementById('accountVerificationModal');
      modal.style.display = 'flex';
      return;
    }

    // Show account verification modal
    showAccountVerification(verifyData, async (accountData) => {
      try {
        toast('Fetching from MongoDB...');
        // Step 2: Execute the mongo query
        const mongoRes = await fetch(`${API}/api/execute-mongo-query`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folioTransactions })
        });
        const mongoData = await mongoRes.json();
        if (mongoData.error) { 
          toast('Error: ' + mongoData.error);
          if (mongoData.hint) console.log('Hint:', mongoData.hint);
          return; 
        }

        // Show result info
        document.getElementById('mongoResultCard').style.display = 'block';
        document.getElementById('mongoResultInfo').innerHTML = `
          <div style="font-size:0.85rem;">
            <strong>Account ID:</strong> ${mongoData.accountId} &nbsp;|&nbsp;
            <strong>Account Type:</strong> ${mongoData.accountType} &nbsp;|&nbsp;
            <strong>Rows:</strong> ${mongoData.rowCount} &nbsp;|&nbsp;
            <strong>Tenant:</strong> ${mongoData.tenantId} &nbsp;|&nbsp;
            <strong>Property:</strong> ${mongoData.propertyId}
          </div>`;

        // Show first few rows in a table
        const rows = mongoData.rows || [];
        lastRawCsvRows = rows; // store raw rows for deep reference analysis
        if (mongoData.mongoQuery) lastMongoQuery = mongoData.mongoQuery;
        window._lastMongoMeta = { tenantId: mongoData.tenantId, propertyId: mongoData.propertyId };
        if (rows.length) {
          document.getElementById('mongoResultTable').innerHTML = renderTable(
            ['lineItemNo', 'type', 'originalType', 'totalAmount', 'sourceAcctType', 'destAcctType', 'description'],
            rows.slice(0, 50).map(r => [r.lineItemNo, r.type, r.originalType, r.totalAmount, r.sourceAccountType, r.destinationAccountType, (r.description || '').substring(0, 30)])
          ) + (rows.length > 50 ? `<p style="color:var(--subtext);font-size:0.8rem;">...and ${rows.length - 50} more rows</p>` : '');
        }

        // Step 3: Run comparison using the fetched data
        toast('Running comparison...');
        const compareRes = await fetch(`${API}/api/compare`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvData: rows, folioTransactions })
        });
        const result = await compareRes.json();
        if (result.error) { toast('Error: ' + result.error); return; }

        lastComparisonResult = result;
        lastCsvData = result;
        renderComparisonResults(result);
        document.querySelector('[data-panel="comparison"]').click();
        toast('Comparison complete!');
      } catch (e) { toast('Error: ' + e.message); }
    });
  } catch (e) {
    toast('Failed: ' + e.message);
  }
}

// ==================== Rules ====================
async function loadRules() {
  try {
    const res = await fetch(`${API}/api/rules`);
    const data = await res.json();
    document.getElementById('rulesEditor').value = data.rules || '';
  } catch (e) { toast('Failed to load rules'); }
}

async function saveRules() {
  const rules = document.getElementById('rulesEditor').value;
  try {
    const res = await fetch(`${API}/api/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules })
    });
    const data = await res.json();
    if (data.success) toast('Rules saved!');
    else toast('Error saving rules');
  } catch (e) { toast('Error: ' + e.message); }
}

async function loadBuiltInRules() {
  try {
    const res = await fetch(`${API}/api/built-in-rules`);
    const data = await res.json();
    const el = document.getElementById('builtInRulesList');
    el.innerHTML = renderTable(
      ['Rule', 'Expected transType'],
      (data.rules || []).map(r => [r.name, r.expectedTransType])
    );
  } catch (e) { console.error('Failed to load built-in rules', e); }
}

// ==================== LLM ====================
async function checkLlmStatus() {
  try {
    const res = await fetch(`${API}/api/llm-status`);
    const data = await res.json();
    document.getElementById('llmStatus').innerHTML = data.available
      ? '<div class="status status-ok">✅ Ollama is running</div>'
      : '<div class="status status-err">⚠️ Ollama not available. Run: <code>ollama serve</code></div>';
  } catch { document.getElementById('llmStatus').innerHTML = '<div class="status status-err">⚠️ Cannot reach server</div>'; }
}

async function runLlmAnalysis() {
  const txInput = document.getElementById('llmTransactionInput').value.trim();
  if (!txInput) { toast('Paste transaction data'); return; }
  const { data: transactionData, error } = jsonParse(txInput);
  if (error) { toast('Invalid JSON: ' + error); return; }

  const traceInput = document.getElementById('llmTraceInput').value.trim();
  let codePathTrace = null;
  if (traceInput) {
    const parsed = jsonParse(traceInput);
    codePathTrace = parsed.data;
  }

  const model = document.getElementById('llmModel').value || 'llama3.2';
  document.getElementById('llmOutput').innerHTML = '<div class="spinner"></div> Analyzing...';

  try {
    const res = await fetch(`${API}/api/llm-analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionData, codePathTrace, model })
    });
    const data = await res.json();
    document.getElementById('llmOutput').textContent = data.explanation || 'No explanation returned.';
  } catch (e) {
    document.getElementById('llmOutput').textContent = 'Error: ' + e.message;
  }
}

// ==================== Deep Reference Analysis ====================
async function runDeepReferenceAnalysis() {
  if (!lastFolioTransactions) { toast('No folioTransactions — run comparison first'); return; }

  let csvData = lastRawCsvRows;
  if (!csvData || csvData.length === 0) {
    if (Array.isArray(lastCsvData)) csvData = lastCsvData;
  }

  if (!csvData || csvData.length === 0) {
    toast('No CSV/MongoDB data found. Please run comparison with MongoDB data first.');
    return;
  }

  const statusEl = document.getElementById('deepReferenceStatus');
  const resultsEl = document.getElementById('deepReferenceResults');
  statusEl.innerHTML = '<div class="spinner"></div> Analysing transfer references and computing correct trnsfrFromLineItemNo values…';
  resultsEl.innerHTML = '';

  // Reset the deep-corrected payload card while analysis is running
  const deepCard = document.getElementById('deepCorrectedPayloadCard');
  if (deepCard) deepCard.style.display = 'none';
  lastDeepCorrectedPayload = null;

  try {
    // Single call — server now handles DB lookups for missing parent transactions internally
    const res = await fetch(`${API}/api/deep-reference-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions: lastFolioTransactions, csvData }),
    });
    const data = await res.json();
    if (data.error) { statusEl.innerHTML = `<div class="status status-err">❌ ${data.error}</div>`; return; }

    renderDeepReferenceResults(data, statusEl, resultsEl);
  } catch (e) {
    statusEl.innerHTML = `<div class="status status-err">❌ Error: ${e.message}</div>`;
  }
}

function renderDeepReferenceResults(data, statusEl, resultsEl) {
  // Status banner
  const isPassing = data.status === 'PASS';
  let statusHtml = `<div class="status ${isPassing ? 'status-ok' : 'status-err'}">
    ${isPassing ? '✅ All transfer references validated — PASS' : '⚠️ Issues found — FAIL'}
  </div>`;

  if (data.summary?.dbRowsFetched > 0) {
    statusHtml += `<div class="status status-ok" style="margin-top:0.3rem;">🗄️ ${data.summary.dbRowsFetched} additional row(s) fetched from DB to resolve parent transactions</div>`;
  }

  statusEl.innerHTML = statusHtml;

  // Summary grid
  const s = data.summary;
  let html = `<div class="summary-grid" style="margin-bottom:1rem;">
    <div class="summary-item"><div class="num" style="color:var(--accent)">${s.totalTransfersChecked}</div><div class="lbl">Transfers Checked</div></div>
    <div class="summary-item"><div class="num" style="color:var(--green)">${s.valid}</div><div class="lbl">Valid</div></div>
    <div class="summary-item"><div class="num" style="color:var(--red)">${s.mismatches}</div><div class="lbl">Mismatches</div></div>
    <div class="summary-item"><div class="num" style="color:var(--yellow)">${s.unresolved ?? 0}</div><div class="lbl">Unresolved</div></div>
    <div class="summary-item"><div class="num" style="color:var(--yellow)">${(data.transferVerifications || []).filter(v => v.status === 'csv_row_not_found').length}</div><div class="lbl">Not in CSV Data</div></div>
    <div class="summary-item"><div class="num" style="color:var(--peach)">${s.taxExemptViolations ?? 0}</div><div class="lbl">Tax-Exempt Violations</div></div>
    <div class="summary-item"><div class="num" style="color:var(--peach)">${s.taxReferenceChains}</div><div class="lbl">Tax Chains</div></div>
    <div class="summary-item"><div class="num" style="color:var(--subtext)">${s.referenceIdsChecked}</div><div class="lbl">Ref IDs Checked</div></div>
  </div>`;

  // Transfer Verifications Table
  if (data.transferVerifications && data.transferVerifications.length > 0) {
    html += `<h4 style="margin:0.5rem 0 0.3rem;color:var(--accent);">Transfer Verifications</h4>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:0.8rem;">
      <thead><tr>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--accent);">lineItemNo</th>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--accent);">Status</th>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--accent);">Existing trnsfrFromLineItemNo</th>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--green);">✅ Correct trnsfrFromLineItemNo</th>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--accent);">Resolution</th>
        <th style="padding:0.4rem 0.6rem;border:1px solid var(--border);background:var(--surface);color:var(--accent);">Debug Log</th>
      </tr></thead><tbody>`;

    data.transferVerifications.forEach((v, idx) => {
      const isOk = v.status === 'valid';
      const isBad = v.status === 'mismatch';
      const isTaxExempt = v.status === 'tax_exempt_violation';
      const isUnresolved = v.status === 'unresolved';
      const isCsvNotFound = v.status === 'csv_row_not_found';
      const statusBadge = isOk ? badge('✓ valid', 'green')
        : isBad ? badge('✗ mismatch', 'red')
        : isTaxExempt ? badge('🚫 tax-exempt violation', 'red')
        : isCsvNotFound ? badge('⚠ not in CSV data', 'yellow')
        : badge(v.status, 'yellow');

      const rowBg = (isBad || isTaxExempt) ? 'rgba(243,139,168,0.07)' : isOk ? 'rgba(166,227,161,0.07)' : isCsvNotFound ? 'rgba(249,226,175,0.07)' : '';

      // Correct value cell — highlight when it differs from existing
      let correctCell;
      if (isTaxExempt) {
        correctCell = `<span style="color:var(--red);font-weight:700;">Remove folioTransferDetails</span>`;
      } else if (v.correctTrnsfrFromLineItemNo == null) {
        correctCell = `<span style="color:var(--subtext);font-style:italic;">—</span>`;
      } else if (isOk) {
        correctCell = `<span style="font-family:monospace;color:var(--green);font-weight:700;">${v.correctTrnsfrFromLineItemNo}</span>`;
      } else {
        // mismatch — show correct value in bold red/peach so it stands out
        correctCell = `<span style="font-family:monospace;color:var(--peach);font-weight:700;font-size:0.9rem;">${v.correctTrnsfrFromLineItemNo}</span>`;
      }

      // Debug log section
      let debugHtml = '';
      if (v.debugSteps && v.debugSteps.length > 0) {
        const logId = `dbgLog_${idx}`;
        debugHtml = `<details id="${logId}">
          <summary style="cursor:pointer;color:var(--accent);font-size:0.75rem;user-select:none;">📋 Show steps (${v.debugSteps.length})</summary>
          <pre style="font-size:0.7rem;white-space:pre-wrap;word-break:break-all;margin-top:0.3rem;max-height:300px;overflow:auto;background:var(--bg);border:1px solid var(--border);padding:0.5rem;border-radius:4px;">${v.debugSteps.join('\n')}</pre>
        </details>`;
      }

      html += `<tr style="background:${rowBg}">
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);font-family:monospace;">${v.lineItemNo}</td>
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);">${statusBadge}</td>
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);font-family:monospace;">${v.existingTrnsfrFromLineItemNo ?? '-'}</td>
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);">${correctCell}</td>
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);font-size:0.72rem;color:var(--subtext);">${v.resolution || v.message || '-'}</td>
        <td style="padding:0.4rem 0.6rem;border:1px solid var(--border);">${debugHtml}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  // Reference ID Results (collapsible)
  if (data.referenceIdResults && data.referenceIdResults.length > 0) {
    html += `<details style="margin-top:0.8rem;">
      <summary style="cursor:pointer;color:var(--accent);font-weight:600;">🔑 Direct Reference ID Results (${data.referenceIdResults.length})</summary>
      <div style="margin-top:0.5rem;">`;
    html += renderTable(
      ['lineItemNo', 'Ref Type', 'Reference ID', 'Correct trnsfrFromLineItemNo (first 10 digits)'],
      data.referenceIdResults.map(r => [
        r.lineItemNo,
        r.referenceType,
        `<span style="font-family:monospace;font-size:0.75rem;">${r.referenceId || '-'}</span>`,
        r.correctTrnsfrFromLineItemNo
          ? `<strong style="color:var(--green);">${r.correctTrnsfrFromLineItemNo}</strong>`
          : `<span style="color:var(--subtext);">—</span>`,
      ])
    );
    html += `</div></details>`;
  }

  // Tax Reference Results (collapsible)
  if (data.taxReferenceResults && data.taxReferenceResults.length > 0) {
    html += `<details style="margin-top:0.8rem;">
      <summary style="cursor:pointer;color:var(--accent);font-weight:600;">💰 Tax Reference Chain Results (${data.taxReferenceResults.length})</summary>
      <div style="margin-top:0.5rem;">`;
    html += renderTable(
      ['lineItemNo', 'Tax Ref ID', 'Parent Ref Type', 'Parent Ref ID', 'Matched transactionId', 'Correct trnsfrFromLineItemNo'],
      data.taxReferenceResults.map(r => [
        r.lineItemNo,
        `<span style="font-family:monospace;font-size:0.75rem;">${r.taxReferenceId || '-'}</span>`,
        r.parentRefType || '-',
        `<span style="font-family:monospace;font-size:0.75rem;">${r.parentRefId || '-'}</span>`,
        `<span style="font-family:monospace;font-size:0.75rem;">${r.matchedTransactionId || '-'}</span>`,
        r.correctTrnsfrFromLineItemNo
          ? `<strong style="color:var(--green);">${r.correctTrnsfrFromLineItemNo}</strong>`
          : `<span style="color:var(--red);">${r.status || 'unresolved'}</span>`,
      ])
    );
    html += `</div></details>`;
  }

  resultsEl.innerHTML = html;
  toast(`Deep analysis complete: ${s.valid} valid, ${s.mismatches} mismatches, ${s.taxExemptViolations ?? 0} tax-exempt violations`);

  // ── Build Deep Analysis Corrected Payload ──────────────────────────────
  // Use the comparison-corrected payload as the base (if available), else raw folioTransactions
  const basePayload = lastMergedPayload || lastFolioTransactions;
  const card = document.getElementById('deepCorrectedPayloadCard');

  if (!basePayload) {
    if (card) card.style.display = 'none';
    return;
  }

  const { corrected, diffs } = applyDeepAnalysisCorrections(basePayload, data.transferVerifications || []);
  lastDeepCorrectedPayload = corrected;

  if (card) card.style.display = 'block';

  // Diff summary table
  const diffsEl = document.getElementById('deepCorrectedDiffs');
  if (diffsEl) {
    if (diffs.length === 0) {
      diffsEl.innerHTML = '<div class="status status-ok">✅ No corrections needed — payload is already correct per deep analysis</div>';
    } else {
      diffsEl.innerHTML =
        `<div style="font-size:0.85rem;font-weight:600;margin-bottom:0.4rem;color:var(--peach);">🔧 ${diffs.length} correction(s) applied by deep analysis:</div>` +
        renderTable(
          ['lineItemNo', 'Action', 'From', 'To', 'Reason'],
          diffs.map(d => [
            `<span style="font-family:monospace;">${d.lineItemNo}</span>`,
            `<strong>${d.action}</strong>`,
            `<span style="font-family:monospace;color:var(--red);font-size:0.75rem;word-break:break-all;">${d.from}</span>`,
            `<span style="font-family:monospace;color:var(--green);font-size:0.75rem;">${d.to}</span>`,
            `<span style="font-size:0.72rem;color:var(--subtext);">${d.reason}</span>`,
          ])
        );
    }
  }

  // Side-by-side JSON diff comparator (Original ↔ Deep Corrected)
  const deepJsonCompEl = document.getElementById('deepJsonComparator');
  if (deepJsonCompEl) {
    deepJsonCompEl.innerHTML = renderDeepJsonComparator(basePayload, corrected);
    // Wire up scroll sync for the deep comparator panes
    const leftPane = document.getElementById('jcDeepLeft');
    const rightPane = document.getElementById('jcDeepRight');
    if (leftPane && rightPane) {
      leftPane.onscroll = () => { rightPane.scrollTop = leftPane.scrollTop; rightPane.scrollLeft = leftPane.scrollLeft; };
      rightPane.onscroll = () => { leftPane.scrollTop = rightPane.scrollTop; leftPane.scrollLeft = rightPane.scrollLeft; };
    }
  }

  // Full corrected payload JSON
  const outputEl = document.getElementById('deepCorrectedPayloadOutput');
  if (outputEl) outputEl.textContent = JSON.stringify(corrected, null, 2);
}

// ==================== Environment Config ====================

function onEnvChange() {
  const mode = document.getElementById('envSelector').value;
  document.getElementById('customEnvFields').style.display = mode === 'other' ? 'block' : 'none';
  document.getElementById('envStatusBadge').innerHTML = ''; // clear status until Apply is clicked
}

async function applyEnvironment() {
  const mode = document.getElementById('envSelector').value;
  const payload = { mode };

  if (mode === 'other') {
    const uri = document.getElementById('customMongoUri').value.trim();
    const tenantId = document.getElementById('customTenantId').value.trim();
    const propertyId = document.getElementById('customPropertyId').value.trim();
    const dbName = document.getElementById('customDbName').value.trim();

    if (!uri)        { toast('Connection string is required for custom environment'); return; }
    if (!tenantId)   { toast('Tenant ID is required for custom environment'); return; }
    if (!propertyId) { toast('Property ID is required for custom environment'); return; }

    payload.uri = uri;
    payload.tenantId = tenantId;
    payload.propertyId = propertyId;
    if (dbName) payload.dbName = dbName;
  }

  try {
    const res = await fetch(`${API}/api/set-environment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }

    const badge = document.getElementById('envStatusBadge');
    if (mode === 'production') {
      badge.innerHTML = '<div class="status status-ok">✅ Production environment active</div>';
      toast('Switched to Production');
    } else {
      badge.innerHTML = `<div class="status status-ok">✅ Custom environment active — tenantId: <strong>${data.tenantId}</strong> propertyId: <strong>${data.propertyId}</strong>${data.dbName ? ' db: <strong>' + data.dbName + '</strong>' : ''}</div>`;
      toast('Custom environment applied');
    }
  } catch (e) {
    toast('Failed to apply environment: ' + e.message);
  }
}

/** Load current environment from server on page init and restore the UI. */
async function loadEnvironment() {
  try {
    const res = await fetch(`${API}/api/get-environment`);
    const data = await res.json();
    if (data.error) return;

    const sel = document.getElementById('envSelector');
    const badge = document.getElementById('envStatusBadge');
    if (!sel) return;

    sel.value = data.mode || 'production';

    if (data.mode === 'other') {
      document.getElementById('customEnvFields').style.display = 'block';
      if (data.tenantId)  document.getElementById('customTenantId').value  = data.tenantId;
      if (data.propertyId) document.getElementById('customPropertyId').value = data.propertyId;
      if (data.dbName)    document.getElementById('customDbName').value    = data.dbName;
      // Note: URI is never returned by the server (security) — user must re-enter it
      badge.innerHTML = `<div class="status status-ok">✅ Custom environment active — tenantId: <strong>${data.tenantId}</strong> propertyId: <strong>${data.propertyId}</strong>${data.dbName ? ' db: <strong>' + data.dbName + '</strong>' : ''}<br><span style="color:var(--yellow);font-size:0.75rem;">⚠️ Re-enter connection string and click Apply to re-activate after page reload</span></div>`;
    } else {
      badge.innerHTML = '<div class="status status-ok">✅ Production environment active</div>';
    }
  } catch { /* ignore — server may not be running yet */ }
}

// ==================== Init ====================
loadRules();
loadBuiltInRules();
checkLlmStatus();
loadEnvironment();

// ==================== Orchestrator ====================
let orchSessionId = null;
let orchPendingStepId = null;

async function startOrchestrator() {
  const jsonInput = document.getElementById('folioJsonInput').value.trim();
  if (!jsonInput) { toast('Paste folioTransactions in the Inputs tab first'); return; }
  const { data: folioTransactions, error } = jsonParse(jsonInput);
  if (error) { toast('Invalid JSON: ' + error); return; }

  let rules = [];
  const rulesInput = document.getElementById('orchRules').value.trim();
  if (rulesInput) {
    const rp = jsonParse(rulesInput);
    if (rp.error) { toast('Invalid rules JSON'); return; }
    rules = rp.data;
  }

  document.getElementById('orchApprovalCard').style.display = 'none';
  document.getElementById('orchResultCard').style.display = 'none';
  toast('Starting orchestrator...');

  try {
    const res = await fetch(`${API}/api/orchestrator/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions, rules, request: 'Analyze and fix payload' })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }

    orchSessionId = data.sessionId;
    renderOrchTimeline(data.steps);
    handleOrchPending(data);
  } catch (e) { toast('Failed: ' + e.message); }
}

async function advanceOrchestrator() {
  if (!orchSessionId) { toast('No session — start the orchestrator first'); return; }
  try {
    const res = await fetch(`${API}/api/orchestrator/advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: orchSessionId })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }
    renderOrchTimeline(data.steps);
    handleOrchPending(data);
  } catch (e) { toast('Failed: ' + e.message); }
}

function handleOrchPending(data) {
  if (data.pendingStep) {
    orchPendingStepId = data.pendingStep.id;
    document.getElementById('orchApprovalCard').style.display = 'block';
    document.getElementById('orchApprovalTitle').textContent = data.pendingStep.title;
    document.getElementById('orchApprovalDesc').textContent = data.pendingStep.description;
    document.getElementById('orchApprovalQuery').value = data.pendingStep.query || '';
    document.getElementById('orchApprovalVars').textContent = JSON.stringify(data.pendingStep.variables, null, 2);
    document.getElementById('orchApprovalRules').textContent = (data.pendingStep.ruleOverrides || []).join(' | ') || '';

    // Show graph response section for graph queries
    document.getElementById('orchGraphResponseSection').style.display =
      data.pendingStep.type === 'graph_query' ? 'block' : 'none';

    document.getElementById('orchResultCard').style.display = 'none';
  } else {
    document.getElementById('orchApprovalCard').style.display = 'none';
    if (data.status === 'completed') {
      showOrchResult(data);
    }
  }
}

async function orchApproveStep() {
  if (!orchSessionId || !orchPendingStepId) return;
  let responseData = null;
  const graphInput = document.getElementById('orchGraphResponse').value.trim();
  if (graphInput) {
    const { data, error } = jsonParse(graphInput);
    if (error) { toast('Invalid graph response JSON'); return; }
    responseData = data;
  }

  toast('Executing step...');
  try {
    const res = await fetch(`${API}/api/orchestrator/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: orchSessionId, stepId: orchPendingStepId, action: 'approve', responseData })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }
    renderOrchTimeline(data.steps);
    handleOrchPending(data);
  } catch (e) { toast('Failed: ' + e.message); }
}

async function orchModifyStep() {
  if (!orchSessionId || !orchPendingStepId) return;
  const modification = document.getElementById('orchApprovalQuery').value;
  let responseData = null;
  const graphInput = document.getElementById('orchGraphResponse').value.trim();
  if (graphInput) {
    const { data, error } = jsonParse(graphInput);
    if (error) { toast('Invalid graph response JSON'); return; }
    responseData = data;
  }

  try {
    const res = await fetch(`${API}/api/orchestrator/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: orchSessionId, stepId: orchPendingStepId, action: 'modify', modification, responseData })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }
    renderOrchTimeline(data.steps);
    handleOrchPending(data);
  } catch (e) { toast('Failed: ' + e.message); }
}

async function orchRejectStep() {
  if (!orchSessionId || !orchPendingStepId) return;
  try {
    const res = await fetch(`${API}/api/orchestrator/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: orchSessionId, stepId: orchPendingStepId, action: 'reject' })
    });
    const data = await res.json();
    if (data.error) { toast('Error: ' + data.error); return; }
    renderOrchTimeline(data.steps);
    handleOrchPending(data);
  } catch (e) { toast('Failed: ' + e.message); }
}

function renderOrchTimeline(steps) {
  const el = document.getElementById('orchTimeline');
  if (!steps || !steps.length) { el.innerHTML = '<p style="color:var(--subtext)">No steps yet.</p>'; return; }
  const icons = { executed: '✅', awaiting_approval: '⏳', pending: '⏸️', rejected: '❌', failed: '💥', skipped: '⏭️', approved: '👍' };
  const colors = { executed: 'var(--green)', awaiting_approval: 'var(--yellow)', pending: 'var(--subtext)', rejected: 'var(--red)', failed: 'var(--red)', skipped: 'var(--subtext)', approved: 'var(--accent)' };

  el.innerHTML = steps.map((s, i) => `
    <div style="display:flex; align-items:flex-start; gap:0.6rem; padding:0.5rem 0; border-bottom:1px solid var(--border);">
      <span style="font-size:1.2rem;">${icons[s.status] || '❓'}</span>
      <div style="flex:1;">
        <div style="font-weight:600; color:${colors[s.status] || 'var(--text)'};">${i + 1}. ${s.title}</div>
        <div style="font-size:0.75rem; color:var(--subtext);">${s.description}</div>
        ${s.error ? `<div style="font-size:0.75rem; color:var(--red); margin-top:0.2rem;">Error: ${s.error}</div>` : ''}
        ${s.ruleOverrides?.length ? `<div style="font-size:0.7rem; color:var(--peach);">${s.ruleOverrides.join(', ')}</div>` : ''}
      </div>
      <span style="font-size:0.7rem; color:var(--subtext);">${s.type}</span>
    </div>
  `).join('');
}

async function showOrchResult(data) {
  document.getElementById('orchResultCard').style.display = 'block';
  // Fetch full session to get corrected payload
  try {
    const res = await fetch(`${API}/api/orchestrator/session/${data.sessionId}`);
    const session = await res.json();
    const summary = [];
    if (session.context?.comparisonResult) {
      const cr = session.context.comparisonResult;
      summary.push(`Missing: ${cr.missing?.length || 0} | Extra: ${cr.extra?.length || 0} | Mismatches: ${cr.mismatches?.length || 0}`);
    }
    if (session.context?.diffs) {
      summary.push(`Corrections applied: ${session.context.diffs.length}`);
    }
    document.getElementById('orchResultSummary').innerHTML = summary.map(s => `<div>${s}</div>`).join('');
    document.getElementById('orchResultPayload').textContent =
      session.context?.correctedPayload ? JSON.stringify(session.context.correctedPayload, null, 2) : 'No corrected payload generated.';
  } catch (e) {
    document.getElementById('orchResultSummary').textContent = 'Session completed.';
  }
}


/**
 * Execute MongoDB query with account verification and query approval modals
 * First verifies the account information, then shows query for review/editing before execution
 */
async function executeMongoQueryWithApproval(folioTransactions, onSuccess) {
  try {
    // Step 1: Verify account information (NEW - initial modal check)
    toast('Verifying account information...');
    const verifyRes = await fetch(`${API}/api/verify-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioTransactions })
    });
    
    const verifyData = await verifyRes.json();
    if (verifyData.error) {
      toast('Error verifying account: ' + verifyData.error);
      showAccountVerificationError(verifyData.error);
      const modal = document.getElementById('accountVerificationModal');
      // Show modal with error state
      document.getElementById('verifyPropertyCode').textContent = 'N/A';
      document.getElementById('verifyChargePostingSeq').textContent = 'N/A';
      document.getElementById('verifyTenantId').textContent = 'N/A';
      document.getElementById('verifyPropertyId').textContent = 'N/A';
      document.getElementById('verifyAccountId').textContent = 'N/A';
      document.getElementById('verifyAccountType').textContent = 'N/A';
      showAccountVerificationError(verifyData.error);
      modal.style.display = 'flex';
      return;
    }

    // Show account verification modal
    showAccountVerification(verifyData, async (accountData) => {
      try {
        // Step 2: Generate the query to show user (AFTER account verification)
        toast('Generating MongoDB query...');
        const generateRes = await fetch(`${API}/api/generate-mongo-query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folioTransactions, accountId: accountData.accountId })
        });
        
        const generateData = await generateRes.json();
        if (generateData.error) {
          toast('Error generating query: ' + generateData.error);
          return;
        }

        // Parse the aggregation query
        let queryObj;
        try {
          queryObj = JSON.parse(generateData.mongoAggregationQuery);
        } catch (e) {
          queryObj = generateData.mongoAggregationQuery;
        }

         // Step 3: Execute MongoDB query directly without approval modal
         try {
           toast('Executing MongoDB query...');
           const executeRes = await fetch(`${API}/api/execute-mongo-query`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ 
               folioTransactions,
               customQuery: queryObj
             })
           });

           const executeData = await executeRes.json();
           if (executeData.error) {
             toast('Error: ' + executeData.error);
             return;
           }

           // Call success callback with the data
           onSuccess(executeData);
         } catch (e) {
           toast('Failed to execute query: ' + e.message);
         }
      } catch (e) {
        toast('Failed: ' + e.message);
      }
    });
  } catch (e) {
    toast('Failed: ' + e.message);
  }
}

// ==================== MongoDB Query Logs ====================

let _logsAutoRefreshTimer = null;

async function refreshMongoLogs() {
  try {
    const res = await fetch(`${API}/api/mongo-logs`);
    const data = await res.json();
    renderMongoLogs(data.logs || []);
    document.getElementById('logsLastRefreshed').textContent =
      'Last refreshed: ' + new Date().toLocaleTimeString();
  } catch (e) {
    toast('Failed to load logs: ' + e.message);
  }
}

async function clearMongoLogs() {
  if (!confirm('Clear all query logs?')) return;
  try {
    await fetch(`${API}/api/mongo-logs`, { method: 'DELETE' });
    renderMongoLogs([]);
    toast('Logs cleared');
  } catch (e) {
    toast('Failed to clear logs: ' + e.message);
  }
}

function toggleLogsAutoRefresh() {
  const checked = document.getElementById('logsAutoRefresh').checked;
  if (checked) {
    refreshMongoLogs();
    _logsAutoRefreshTimer = setInterval(refreshMongoLogs, 5000);
  } else {
    clearInterval(_logsAutoRefreshTimer);
    _logsAutoRefreshTimer = null;
  }
}

function renderMongoLogs(logs) {
  const tbody = document.getElementById('logsTableBody');
  const summary = document.getElementById('logsSummary');

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--subtext);padding:1.5rem;">No queries recorded yet.</td></tr>';
    summary.innerHTML = '';
    return;
  }

  // Summary counts
  const total = logs.length;
  const success = logs.filter(l => l.status === 'success').length;
  const errors = logs.filter(l => l.status === 'error').length;
  const running = logs.filter(l => l.status === 'running').length;
  const durations = logs.filter(l => l.durationMs != null).map(l => l.durationMs);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const maxMs = durations.length ? Math.max(...durations) : 0;

  summary.innerHTML = `
    <div class="summary-item"><div class="num">${total}</div><div class="lbl">Total Queries</div></div>
    <div class="summary-item"><div class="num" style="color:var(--green)">${success}</div><div class="lbl">Success</div></div>
    <div class="summary-item"><div class="num" style="color:var(--red)">${errors}</div><div class="lbl">Errors</div></div>
    <div class="summary-item"><div class="num" style="color:var(--yellow)">${running}</div><div class="lbl">Running</div></div>
    <div class="summary-item"><div class="num">${avgMs}<span style="font-size:1rem">ms</span></div><div class="lbl">Avg Duration</div></div>
    <div class="summary-item"><div class="num">${maxMs}<span style="font-size:1rem">ms</span></div><div class="lbl">Max Duration</div></div>
  `;

  tbody.innerHTML = logs.map(l => {
    const statusColor = l.status === 'success' ? 'var(--green)' :
                        l.status === 'error'   ? 'var(--red)'   :
                        l.status === 'running' ? 'var(--yellow)' : 'var(--subtext)';
    const statusIcon  = l.status === 'success' ? '✅' :
                        l.status === 'error'   ? '❌' :
                        l.status === 'running' ? '⏳' : '—';

    const durationDisplay = l.durationMs != null
      ? `<span style="color:${l.durationMs > 5000 ? 'var(--red)' : l.durationMs > 1000 ? 'var(--yellow)' : 'var(--green)'}">${l.durationMs} ms</span>`
      : '<span style="color:var(--subtext)">—</span>';

    // Format timestamp as local time
    const ts = new Date(l.startedAt).toLocaleTimeString();

    // Params summary (short)
    let paramsDisplay = l.params || '';
    if (paramsDisplay.length > 80) paramsDisplay = paramsDisplay.slice(0, 77) + '…';

    // Full query expandable section
    const queryId = `logQuery_${l.id}`;
    const hasQuery = !!l.query;
    const querySection = hasQuery
      ? `<details id="${queryId}" style="margin-top:0.3rem;">
           <summary style="cursor:pointer;color:var(--accent);font-size:0.75rem;user-select:none;">🔍 View Full Query</summary>
           <div style="position:relative;margin-top:0.3rem;">
             <button onclick="copyLogQuery(${l.id})" style="position:absolute;top:4px;right:4px;padding:0.2rem 0.5rem;font-size:0.7rem;background:var(--border);color:var(--text);border:none;border-radius:3px;cursor:pointer;z-index:1;">📋 Copy</button>
             <pre id="logQueryPre_${l.id}" style="font-size:0.72rem;white-space:pre-wrap;word-break:break-all;margin:0;max-height:400px;overflow:auto;background:var(--bg);border:1px solid var(--border);padding:0.5rem;border-radius:4px;padding-right:4rem;">${escapeHtml(l.query)}</pre>
           </div>
         </details>`
      : '<span style="color:var(--subtext);font-size:0.75rem;">—</span>';

    const errorRow = l.error
      ? `<tr style="background:rgba(243,139,168,0.07)"><td colspan="8" style="color:var(--red);font-size:0.75rem;padding:0.25rem 0.6rem;">⚠️ ${escapeHtml(l.error)}</td></tr>`
      : '';

    return `
      <tr>
        <td style="color:var(--subtext)">${l.id}</td>
        <td style="font-family:var(--mono);font-size:0.78rem;">${ts}</td>
        <td>${durationDisplay}</td>
        <td><span style="color:${statusColor}">${statusIcon} ${l.status}</span></td>
        <td style="font-family:var(--mono);font-size:0.78rem;font-weight:600;color:var(--accent)">${escapeHtml(l.label)}</td>
        <td style="font-family:var(--mono);font-size:0.78rem;">${escapeHtml(l.collection)}</td>
        <td style="font-size:0.78rem;">${escapeHtml(l.operation)}</td>
        <td style="text-align:center;">${l.rowCount != null ? l.rowCount : '<span style="color:var(--subtext)">—</span>'}</td>
      </tr>
      <tr style="background:rgba(0,0,0,0.15);">
        <td colspan="8" style="padding:0.3rem 0.8rem 0.6rem 2rem;">
          <div style="font-size:0.75rem;color:var(--subtext);margin-bottom:0.2rem;"><strong>Params:</strong> <span style="font-family:var(--mono);">${escapeHtml(paramsDisplay)}</span></div>
          ${querySection}
        </td>
      </tr>
      ${errorRow}`;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Copy the full query for a specific log entry by id. */
function copyLogQuery(logId) {
  const el = document.getElementById(`logQueryPre_${logId}`);
  if (!el) { toast('Query not found'); return; }
  navigator.clipboard.writeText(el.textContent).then(() => toast('Query copied!'));
}

// Auto-refresh logs when the Logs tab is clicked
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.panel === 'mongoLogs') {
      refreshMongoLogs();
    }
  });
});

