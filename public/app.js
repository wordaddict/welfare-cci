function setRequiredForSection(section, required, includeFiles = true) {
  if (!section) return;
  section.querySelectorAll('input, select, textarea').forEach(el => {
    if (!includeFiles && el.type === 'file') return;
    el.required = !!required;
  });
}

function updateConditional(){
  const select = document.getElementById('requestCategory');
  if(!select) return;
  const value = select.value;
  document.querySelectorAll('.conditional').forEach(section => {
    const isVisible = section.dataset.category === value;
    section.style.display = isVisible ? 'block' : 'none';
    setRequiredForSection(section, isVisible);
  });
}

function updateMapConditional(){
  const membership = document.querySelector('[name="membership_status"]');
  const mapStatus = document.querySelector('[name="map_group_status"]');
  const membershipIsNo = membership && membership.value === 'No';

  if (mapStatus) mapStatus.required = membershipIsNo;

  document.querySelectorAll('.map-conditional').forEach(section => {
    const show = membershipIsNo && mapStatus && mapStatus.value === section.dataset.map;
    section.style.display = show ? 'block' : 'none';
    setRequiredForSection(section, show);
  });
}

function updateMembershipConditional(){
  const membership = document.querySelector('[name="membership_status"]');
  const value = membership ? membership.value : '';

  document.querySelectorAll('.membership-conditional').forEach(section => {
    const show = value && section.dataset.membership === value;
    section.style.display = show ? 'block' : 'none';
    // Nested MAP questions are controlled separately so they are not all required at once.
    section.querySelectorAll(':scope > label > input, :scope > label > select, :scope > label > textarea').forEach(el => {
      el.required = !!show;
    });
  });

  const certificate = document.querySelector('[name="membership_certificate"]');
  if (certificate) certificate.required = value === 'Yes';
  updateMapConditional();
}

function updateWorkerConditional(){
  const worker = document.querySelector('[name="worker_status"]');
  document.querySelectorAll('.worker-conditional').forEach(section => {
    const show = worker && worker.value === section.dataset.worker;
    section.style.display = show ? 'block' : 'none';
    setRequiredForSection(section, show);
  });
}

function updatePastorInformed(){
  const pastorInformed = document.querySelector('[name="pastor_informed"]');
  const warning = document.getElementById('pastorInformWarning');
  const submit = document.getElementById('submitApplicationButton');
  const mustInform = pastorInformed && pastorInformed.value === 'No';
  if(warning) warning.style.display = mustInform ? 'block' : 'none';
  if(submit) submit.disabled = mustInform;
}

function updateConditionalRequireds(){
  const prior = document.querySelector('[name="prior_assistance"]');
  const priorDetails = document.querySelector('[name="prior_assistance_details"]');
  if(prior && priorDetails) priorDetails.required = prior.value === 'Yes';

  const direct = document.querySelector('[name="direct_payment_possible"]');
  const payDetails = document.querySelector('[name="payment_details"]');
  const payExplain = document.querySelector('[name="direct_payment_explanation"]');
  const zelleName = document.querySelector('[name="zelle_name"]');
  const zelleEmail = document.querySelector('[name="zelle_email"]');
  const zellePhone = document.querySelector('[name="zelle_phone"]');

  document.querySelectorAll('.payment-conditional').forEach(section => {
    const show = direct && direct.value && section.dataset.payment === direct.value;
    section.style.display = show ? 'block' : 'none';
    setRequiredForSection(section, show);
  });

  if(direct && payDetails && payExplain){
    payDetails.required = direct.value === 'Yes';
    payExplain.required = direct.value === 'No';
    if(zelleName) zelleName.required = direct.value === 'No';
    if(zelleEmail) zelleEmail.required = direct.value === 'No';
    if(zellePhone) zellePhone.required = direct.value === 'No';
  }
}


function updateFinancialGapPreview(){
  const total = Number((document.getElementById('totalAmountNeeded') || {}).value || 0);
  const contribution = Number((document.getElementById('applicantContribution') || {}).value || 0);
  const other = Number((document.getElementById('otherConfirmedSupport') || {}).value || 0);
  const requested = Number((document.getElementById('amountRequested') || {}).value || 0);
  const gap = Math.max(0, total - contribution - other);
  const preview = document.getElementById('financialGapPreview');
  if(preview){
    preview.textContent = `Estimated remaining financial gap: $${gap.toFixed(2)}` + (requested > gap + 0.009 ? ` · Note: the amount requested from CCI is $${(requested-gap).toFixed(2)} above this calculated gap.` : '');
  }
}

function updateEffortActionValidation(){
  const boxes = Array.from(document.querySelectorAll('input[name="effort_actions"]'));
  if(!boxes.length) return;
  const checked = boxes.filter(b => b.checked);
  const noneBox = boxes.find(b => b.value === 'None yet');
  const conflict = noneBox && noneBox.checked && checked.length > 1;
  boxes[0].setCustomValidity(checked.length === 0 ? 'Please select at least one option. Select None yet if no action has been taken.' : conflict ? 'Please select either None yet or the actions you have taken, not both.' : '');
}

document.addEventListener('DOMContentLoaded', () => {
  const requestCategory = document.getElementById('requestCategory');
  if(requestCategory){
    requestCategory.addEventListener('change', () => { updateConditional(); updateConditionalRequireds(); });
    updateConditional();
  }

  ['prior_assistance','direct_payment_possible'].forEach(name => {
    const el = document.querySelector(`[name="${name}"]`);
    if(el) el.addEventListener('change', updateConditionalRequireds);
  });

  const membership = document.querySelector('[name="membership_status"]');
  if(membership) membership.addEventListener('change', updateMembershipConditional);

  const mapStatus = document.querySelector('[name="map_group_status"]');
  if(mapStatus) mapStatus.addEventListener('change', updateMapConditional);

  const worker = document.querySelector('[name="worker_status"]');
  if(worker) worker.addEventListener('change', updateWorkerConditional);

  const pastorInformed = document.querySelector('[name="pastor_informed"]');
  if(pastorInformed) pastorInformed.addEventListener('change', updatePastorInformed);

  ['totalAmountNeeded','amountRequested','applicantContribution','otherConfirmedSupport'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', updateFinancialGapPreview);
  });
  document.querySelectorAll('input[name="effort_actions"]').forEach(box => box.addEventListener('change', updateEffortActionValidation));

  updateConditionalRequireds();
  updateMembershipConditional();
  updateWorkerConditional();
  updatePastorInformed();
  updateFinancialGapPreview();
  updateEffortActionValidation();
});
