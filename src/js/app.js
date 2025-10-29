const registerModal = document.getElementById("registerModal");
const qrModal = document.getElementById("qrModal");
const infoModal = document.getElementById("infoModal");
const instructionModal = document.getElementById("instructionModal");
const openModalBtn = document.getElementById("openModal");
const openQRModalBtn = document.getElementById("openQRModal");
const openModalFromQR = document.getElementById("openModalFromQR");
const form = document.getElementById("registerForm");
const nameInput = document.getElementById("name");
const phoneInput = document.getElementById("phone");
const ageInput = document.getElementById("age");
const btnNext = document.getElementById("btnNext");
const privacyCheck = document.getElementById("privacy");
const promoCheck = document.getElementById("promo");
const startScanBtn = document.getElementById("startScan");
const btnContinue = document.getElementById("btnContinue");
const btnUnderstand = document.getElementById("btnUnderstand");

const regexPhone = (phone) => /^0[1-9][0-9]{7,11}$/.test(phone);

// === modal open/close (tidak diubah) ===
openModalBtn.addEventListener("click", (e) => {
  e.preventDefault();
  registerModal.classList.add("active");
});
openQRModalBtn.addEventListener("click", (e) => {
  e.preventDefault();
  qrModal.classList.add("active");
});
openModalFromQR.addEventListener("click", (e) => {
  e.preventDefault();
  qrModal.classList.remove("active");
  registerModal.classList.add("active");
});
startScanBtn.addEventListener("click", (e) => {
  e.preventDefault();
  qrModal.classList.remove("active");
  infoModal.classList.add("active");
});
btnContinue.addEventListener("click", (e) => {
  e.preventDefault();
  infoModal.classList.remove("active");
  instructionModal.classList.add("active");
});
btnUnderstand.addEventListener("click", (e) => {
  e.preventDefault();
  instructionModal.classList.remove("active");
  console.log("Start camera scanning");
});

[registerModal, qrModal, infoModal, instructionModal].forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("active");
  });
});

// batasi input phone max 13 digit (hanya angka)
phoneInput.addEventListener("input", () => {
  phoneInput.value = phoneInput.value.replace(/\D/g, "");
  if (phoneInput.value.length > 13)
    phoneInput.value = phoneInput.value.slice(0, 13);
});

// batasi input age max 2 digit
ageInput.addEventListener("input", () => {
  ageInput.value = ageInput.value.replace(/\D/g, "");
  if (ageInput.value.length > 2) ageInput.value = ageInput.value.slice(0, 2);
});

// ===== Perbaikan validateForm =====
function validateForm() {
  const nameFilled = nameInput.value.trim() !== "";
  const phoneFilled = regexPhone(phoneInput.value.trim());
  const ageFilled =
    ageInput.value.trim() !== "" && ageInput.value.trim().length <= 2;
  // pake variable privacyCheck (sudah dideklarasi di atas)
  const checkboxChecked = privacyCheck.checked;

  const formValid = nameFilled && phoneFilled && ageFilled && checkboxChecked;

  // Aktif/non-aktifkan tombol secara eksplisit (lebih reliable daripada properti .active)
  btnNext.disabled = !formValid;

  if (formValid) {
    btnNext.classList.add("active");
    phoneInput.classList.remove("error");
    ageInput.classList.remove("error");
  } else {
    btnNext.classList.remove("active");

    // feedback error kecil
    if (!phoneFilled && phoneInput.value.trim() !== "")
      phoneInput.classList.add("error");
    else phoneInput.classList.remove("error");

    if (!ageFilled && ageInput.value.trim() !== "")
      ageInput.classList.add("error");
    else ageInput.classList.remove("error");
  }
}

// Gunakan 'input' untuk teks, 'change' untuk checkbox
[nameInput, phoneInput, ageInput].forEach((el) =>
  el.addEventListener("input", validateForm)
);
privacyCheck.addEventListener("change", validateForm);
promoCheck.addEventListener("change", validateForm); // kalau mau ikut validasi nanti

// Inisialisasi: disable tombol saat load
btnNext.disabled = true;

// Form submit (gunakan form submit event atau tombol click; disini pakai form submit)
form.addEventListener("submit", (e) => {
  e.preventDefault();
  validateForm(); // final check
  if (btnNext.disabled) {
    // beri feedback
    if (!nameInput.value.trim()) nameInput.classList.add("error");
    if (!regexPhone(phoneInput.value.trim())) phoneInput.classList.add("error");
    if (!ageInput.value.trim() || ageInput.value.length > 2)
      ageInput.classList.add("error");
    return;
  }

  // Ambil data dan lakukan proses berikutnya
  const userData = {
    name: nameInput.value.trim(),
    phone: phoneInput.value.trim(),
    age: parseInt(ageInput.value.trim(), 10),
    acceptPrivacy: privacyCheck.checked,
    acceptPromo: promoCheck.checked,
  };

  console.log("✅ DEBUG: Form data saved to userData:", userData);

  // contoh: tutup modal
  registerModal.classList.remove("active");
});
