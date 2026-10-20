const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FinanceApiError,
  buildFinanceAttachments,
  buildFinanceExpensePayload,
  createFinancePacketService,
  financeExpenseEndpoint,
  financeExpenseRequestHeaders,
  postFinanceExpensePayload
} = require('../src/finance-packet');

function approvedRequest(overrides = {}) {
  return {
    case_id: 'CASE-123',
    amount_approved: 250,
    amount_requested: 300,
    cci_community_name: 'DMV',
    full_name: 'Jane Doe',
    zelle_name: 'Jane Doe',
    zelle_email: 'jane@example.com',
    zelle_phone: '555-0100',
    ...overrides
  };
}

function attachmentFile(overrides = {}) {
  return {
    itemId: 'welfare-assistance',
    fileName: 'committee-approval.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF actual bytes'),
    ...overrides
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

const financeConfig = {
  apiUrl: 'https://finance.example.com',
  apiSecret: 'shared-secret',
  timeoutMs: 1000
};

test('finance payload sends two real files to the same stable item and never sends a ZIP packet', () => {
  const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const payload = buildFinanceExpensePayload({
    request: approvedRequest(),
    attachmentFiles: [
      attachmentFile({ buffer: pdfBytes }),
      attachmentFile({
        fileName: 'supporting-document.png',
        mimeType: 'image/png',
        buffer: pngBytes
      })
    ]
  });

  assert.equal(payload.externalId, 'WELFARE-CASE-123');
  assert.equal(payload.team, 'FOLLOW_UP');
  assert.equal(payload.campus, 'DMV');
  assert.equal(payload.amountCents, 25000);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].tempId, 'welfare-assistance');
  assert.equal(payload.attachments.length, 2);
  assert.deepEqual(payload.attachments.map(file => file.itemId), [
    'welfare-assistance',
    'welfare-assistance'
  ]);
  assert.equal(payload.attachments[0].base64, pdfBytes.toString('base64'));
  assert.equal(payload.attachments[1].base64, pngBytes.toString('base64'));
  assert.equal(Object.hasOwn(payload, 'packet'), false);
  assert.equal(payload.attachments.some(file => file.base64.startsWith('data:')), false);
});

test('finance retry payload preserves the external ID and attachment-to-item mappings', () => {
  const request = approvedRequest({ case_id: 'CCI-FIN-2026-009' });
  const files = [
    attachmentFile(),
    attachmentFile({ fileName: 'evidence.csv', mimeType: 'text/csv', buffer: Buffer.from('amount,25\n') })
  ];

  const firstAttempt = buildFinanceExpensePayload({ request, attachmentFiles: files });
  const retryAttempt = buildFinanceExpensePayload({ request, attachmentFiles: files });

  assert.equal(firstAttempt.externalId, 'WELFARE-CCI-FIN-2026-009');
  assert.equal(retryAttempt.externalId, firstAttempt.externalId);
  assert.deepEqual(
    retryAttempt.attachments.map(file => ({ itemId: file.itemId, fileName: file.fileName })),
    firstAttempt.attachments.map(file => ({ itemId: file.itemId, fileName: file.fileName }))
  );
});

test('finance submission reads every stored document and support letter as actual buffers', async () => {
  const storedFiles = new Map([
    ['doc-1', { storage_key: 'doc-1', original_name: 'invoice.pdf', mime_type: 'application/pdf', data: Buffer.from('invoice bytes') }],
    ['doc-2', { storage_key: 'doc-2', original_name: 'budget.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: Buffer.from('spreadsheet bytes') }],
    ['letter-1', { storage_key: 'letter-1', original_name: 'pastoral-letter.png', mime_type: 'image/png', data: Buffer.from('image bytes') }]
  ]);
  const service = createFinancePacketService({
    baseUrl: () => 'http://localhost:3001',
    getDb: async () => null,
    logActivity: async () => {},
    sendNotification: async () => ({ success: true }),
    appendStoredFileToArchive: async () => {},
    getStoredFileByKey: async (db, storageKey) => storedFiles.get(storageKey) || null,
    getStoredFileBuffer: async storedFile => Buffer.from(storedFile.data),
    fetchImpl: async () => jsonResponse(201, {})
  });

  const files = await service.buildFinanceExpenseAttachmentFiles({}, {
    request: approvedRequest({ decision: 'Full Approval' }),
    docs: [
      { stored_name: 'doc-1', original_name: 'invoice.pdf', mime_type: 'application/pdf' },
      { stored_name: 'doc-2', original_name: 'budget.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    ],
    verifications: [{ support_letter_file: 'letter-1' }],
    assignedReviewers: [],
    reviews: [],
    reviewSummary: { average: 0, averageRounded: 0, averagePercent: 0 }
  });

  assert.equal(files.length, 4);
  assert.match(files[0].fileName, /committee-approval-summary\.pdf$/);
  assert.ok(files[0].buffer.subarray(0, 4).equals(Buffer.from('%PDF')));
  assert.deepEqual(files.slice(1).map(file => [file.fileName, file.mimeType, file.buffer.toString()]), [
    ['invoice.pdf', 'application/pdf', 'invoice bytes'],
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet bytes'],
    ['pastoral-letter.png', 'image/png', 'image bytes']
  ]);
});

test('finance expense payload uses the selected campus and rejects unsupported values', () => {
  const request = approvedRequest({
    case_id: 'CASE-456',
    amount_approved: 100.01,
    cci_community_name: 'CCI_USA_HOUSTON',
    zelle_email: '',
    zelle_phone: '555-0101'
  });

  const payload = buildFinanceExpensePayload({ request, attachmentFiles: [attachmentFile()] });
  assert.equal(payload.campus, 'CCI_USA_HOUSTON');
  assert.equal(payload.amountCents, 10001);
  assert.equal(payload.payeeZelle, '555-0101');

  assert.throws(
    () => buildFinanceExpensePayload({
      request: { ...request, cci_community_name: 'Typed campus' },
      attachmentFiles: [attachmentFile()]
    }),
    /not supported by the finance system/
  );

  assert.throws(
    () => buildFinanceExpensePayload({
      request: { ...request, amount_approved: 0 },
      attachmentFiles: [attachmentFile()]
    }),
    /approved amount must be greater than zero/
  );
});

test('finance attachments enforce count, per-file, and combined decoded-size limits', () => {
  assert.throws(
    () => buildFinanceAttachments(Array.from({ length: 11 }, (_, index) => attachmentFile({ fileName: `file-${index}.pdf` }))),
    /maximum of 10 attachments/
  );

  assert.throws(
    () => buildFinanceAttachments([attachmentFile({ buffer: Buffer.alloc((10 * 1024 * 1024) + 1) })]),
    /exceeds the 10 MB per-file limit/
  );

  const nineMegabytes = Buffer.alloc(9 * 1024 * 1024);
  assert.throws(
    () => buildFinanceAttachments([
      attachmentFile({ fileName: 'one.pdf', buffer: nineMegabytes }),
      attachmentFile({ fileName: 'two.pdf', buffer: nineMegabytes }),
      attachmentFile({ fileName: 'three.pdf', buffer: nineMegabytes })
    ]),
    /25 MB combined decoded-size limit/
  );
});

test('finance attachments preserve supported spreadsheet filenames and MIME types', () => {
  const files = buildFinanceAttachments([
    attachmentFile({ fileName: 'budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    attachmentFile({ fileName: 'legacy.xls', mimeType: 'application/vnd.ms-excel' }),
    attachmentFile({ fileName: 'totals.csv', mimeType: 'text/csv' }),
    attachmentFile({ fileName: 'forecast.ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' })
  ]);

  assert.deepEqual(files.map(file => [file.fileName, file.mimeType]), [
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['legacy.xls', 'application/vnd.ms-excel'],
    ['totals.csv', 'text/csv'],
    ['forecast.ods', 'application/vnd.oasis.opendocument.spreadsheet']
  ]);
  assert.throws(
    () => buildFinanceAttachments([attachmentFile({ fileName: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]),
    /must be a JPG, PNG, PDF, XLSX, XLS, CSV, or ODS/
  );
});

test('finance API treats HTTP 201 as a newly created success', async () => {
  const result = await postFinanceExpensePayload(
    { externalId: 'WELFARE-CASE-123' },
    financeConfig,
    async () => jsonResponse(201, { expense: { id: 'expense-1', externalId: 'WELFARE-CASE-123' } })
  );

  assert.deepEqual(result, {
    duplicate: false,
    expenseId: 'expense-1',
    externalId: 'WELFARE-CASE-123',
    status: 201
  });
});

test('finance API treats HTTP 200 duplicate response as idempotent success', async () => {
  const result = await postFinanceExpensePayload(
    { externalId: 'WELFARE-CASE-123' },
    financeConfig,
    async () => jsonResponse(200, {
      duplicate: true,
      expense: { id: 'expense-existing', externalId: 'WELFARE-CASE-123' }
    })
  );

  assert.equal(result.duplicate, true);
  assert.equal(result.expenseId, 'expense-existing');
  assert.equal(result.externalId, 'WELFARE-CASE-123');
});

test('finance API exposes HTTP 400 validation issues as a permanent failure', async () => {
  await assert.rejects(
    () => postFinanceExpensePayload(
      { externalId: 'WELFARE-CASE-123' },
      financeConfig,
      async () => jsonResponse(400, {
        error: 'Invalid workflow expense payload',
        issues: [{ code: 'too_big', path: ['attachments'], message: 'Maximum 10 attachments' }]
      })
    ),
    (error) => {
      assert.ok(error instanceof FinanceApiError);
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.issues, [{
        code: 'too_big',
        path: ['attachments'],
        message: 'Maximum 10 attachments'
      }]);
      assert.match(error.message, /attachments: Maximum 10 attachments/);
      return true;
    }
  );
});

test('finance API classifies configuration and upstream failures', async () => {
  await assert.rejects(
    () => postFinanceExpensePayload(
      { externalId: 'WELFARE-CASE-123' },
      financeConfig,
      async () => jsonResponse(401, { error: 'Unauthorized' })
    ),
    error => error instanceof FinanceApiError && error.configuration === true && error.retryable === false
  );

  await assert.rejects(
    () => postFinanceExpensePayload(
      { externalId: 'WELFARE-CASE-123' },
      financeConfig,
      async () => jsonResponse(503, { error: 'Workflow expense requester is not configured' })
    ),
    error => error instanceof FinanceApiError && error.configuration === true && error.retryable === false
  );

  await assert.rejects(
    () => postFinanceExpensePayload(
      { externalId: 'WELFARE-CASE-123' },
      financeConfig,
      async () => jsonResponse(502, { error: 'Cloud storage unavailable' })
    ),
    error => error instanceof FinanceApiError && error.status === 502 && error.retryable === true
  );
});

test('finance API uses the established workflow endpoint and bearer authentication', () => {
  assert.deepEqual(financeExpenseRequestHeaders({
    apiSecret: 'shared-secret'
  }), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer shared-secret'
  });
  assert.equal(
    financeExpenseEndpoint({ apiUrl: 'https://finance.example.com/' }),
    'https://finance.example.com/api/integrations/workflow/expenses'
  );
});
