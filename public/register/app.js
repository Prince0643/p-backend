(() => {
  'use strict';

  const form = document.getElementById('registrationForm');
  const successCard = document.getElementById('successCard');
  const formStatus = document.getElementById('formStatus');
  const submitButton = document.getElementById('submitButton');
  const buttonText = document.getElementById('buttonText');

  const phPanel = document.getElementById('phPanel');
  const globalPanel = document.getElementById('globalPanel');
  const phMethod = document.getElementById('phMethod');
  const globalMethod = document.getElementById('globalMethod');
  const ewalletFields = document.getElementById('ewalletFields');
  const bankFields = document.getElementById('bankFields');
  const otherBankGroup = document.getElementById('otherBankGroup');

  const termsDialog = document.getElementById('termsDialog');
  const openTermsBtn = document.getElementById('openTerms');
  const closeTermsBtn = document.getElementById('closeTerms');

  const couponCodeText = document.getElementById('couponCodeText');
  const copyCouponBtn = document.getElementById('copyCouponBtn');

  document.getElementById('year').textContent = new Date().getFullYear();

  function setControls(container, enabled, required = enabled) {
    container.querySelectorAll('input, select').forEach((control) => {
      control.disabled = !enabled;
      control.required = required;
      if (!enabled) {
        control.value = '';
        control.removeAttribute('aria-invalid');
      }
    });
  }

  function resetPhDetailFields() {
    setControls(ewalletFields, false);
    setControls(bankFields, false);
    ewalletFields.hidden = true;
    bankFields.hidden = true;
    otherBankGroup.hidden = true;
    otherBankGroup.querySelector('input').required = false;
  }

  document.querySelectorAll('input[name="paymentRegion"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isPh = radio.value === 'PH';
      phPanel.hidden = !isPh;
      globalPanel.hidden = isPh;
      setControls(phPanel, isPh, false);
      setControls(globalPanel, !isPh, !isPh);
      phMethod.required = isPh;
      globalMethod.required = !isPh;
      resetPhDetailFields();
    });
  });

  phMethod.addEventListener('change', () => {
    resetPhDetailFields();
    const value = phMethod.value;
    if (value === 'GCASH' || value === 'MAYA') {
      ewalletFields.hidden = false;
      setControls(ewalletFields, true);
    } else if (value) {
      bankFields.hidden = false;
      setControls(bankFields, true);
      const isOther = value === 'OTHER';
      otherBankGroup.hidden = !isOther;
      const otherInput = otherBankGroup.querySelector('input');
      otherInput.disabled = !isOther;
      otherInput.required = isOther;
    }
  });

  function normalizePhilippinePhone(input) {
    const digits = input.value.replace(/\D/g, '');
    if (/^09\d{9}$/.test(digits)) input.value = `+63${digits.slice(1)}`;
    else if (/^9\d{9}$/.test(digits)) input.value = `+63${digits}`;
    else if (/^63\d{10}$/.test(digits)) input.value = `+${digits}`;
  }

  document.getElementById('contactNumber').addEventListener('blur', (e) => {
    const region = form.querySelector('input[name="paymentRegion"]:checked')?.value;
    if (region === 'PH') normalizePhilippinePhone(e.currentTarget);
  });
  document.getElementById('ewalletNumber').addEventListener('blur', (e) => normalizePhilippinePhone(e.currentTarget));

  openTermsBtn.addEventListener('click', () => termsDialog.showModal());
  closeTermsBtn.addEventListener('click', () => termsDialog.close());
  termsDialog.addEventListener('click', (e) => { if (e.target === termsDialog) termsDialog.close(); });

  function showError(message) {
    formStatus.textContent = message;
    formStatus.className = 'status error';
    formStatus.classList.remove('hidden');
    formStatus.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearStatus() {
    formStatus.classList.add('hidden');
  }

  function validateForm() {
    let firstInvalid = null;
    form.querySelectorAll('input, select').forEach((control) => {
      if (control.disabled) return;
      const invalid = !control.checkValidity();
      control.toggleAttribute('aria-invalid', invalid);
      if (invalid && !firstInvalid) firstInvalid = control;
    });
    if (firstInvalid) {
      showError('Please complete the highlighted required fields.');
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  function buildPayload() {
    const data = Object.fromEntries(new FormData(form).entries());
    const region = data.paymentRegion;
    data.preferredBank = region === 'PH' ? phMethod.value : globalMethod.value;
    data.termsAccepted = document.getElementById('termsAgreement').checked;
    data.termsVersion = '2026-09-17';
    return data;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitButton.disabled || !validateForm()) return;

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    buttonText.textContent = 'Registering…';
    clearStatus();

    try {
      const res = await fetch('/api/affiliates/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload())
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(result?.error || 'Registration failed. Please check your details and try again.');
      }

      form.classList.add('hidden');
      successCard.classList.remove('hidden');
      couponCodeText.textContent = result.couponCode;
      successCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(err.message || 'We could not complete your registration. Please try again.');
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      buttonText.textContent = 'Complete Registration';
    }
  });

  copyCouponBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(couponCodeText.textContent);
      copyCouponBtn.textContent = 'Copied!';
      setTimeout(() => { copyCouponBtn.textContent = 'Copy'; }, 2000);
    } catch {
      // Clipboard API unavailable - the code is already visible on-screen for manual copy.
    }
  });
})();
