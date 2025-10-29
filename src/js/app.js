const registerModal = document.getElementById('registerModal');
const qrModal = document.getElementById('qrModal');
const infoModal = document.getElementById('infoModal');
const instructionModal = document.getElementById('instructionModal');
const openModalBtn = document.getElementById('openModal');
const openQRModalBtn = document.getElementById('openQRModal');
const openModalFromQR = document.getElementById('openModalFromQR');
const form = document.getElementById('registerForm');
const btnNext = document.getElementById('btnNext');
const inputs = form.querySelectorAll('.form-input');
const privacyCheck = document.getElementById('privacy');
const promoCheck = document.getElementById('promo');
const startScanBtn = document.getElementById('startScan');
const btnContinue = document.getElementById('btnContinue');
const btnUnderstand = document.getElementById('btnUnderstand');

// Open register modal
openModalBtn.addEventListener('click', (e) => {
    e.preventDefault();
    registerModal.classList.add('active');
});

// Open QR modal
openQRModalBtn.addEventListener('click', (e) => {
    e.preventDefault();
    qrModal.classList.add('active');
});

// Open register modal from QR modal
openModalFromQR.addEventListener('click', (e) => {
    e.preventDefault();
    qrModal.classList.remove('active');
    registerModal.classList.add('active');
});

// Start scan button - open info modal
startScanBtn.addEventListener('click', (e) => {
    e.preventDefault();
    qrModal.classList.remove('active');
    infoModal.classList.add('active');
});

// Continue button - open instruction modal
btnContinue.addEventListener('click', (e) => {
    e.preventDefault();
    infoModal.classList.remove('active');
    instructionModal.classList.add('active');
});

// Understand button
btnUnderstand.addEventListener('click', (e) => {
    e.preventDefault();
    instructionModal.classList.remove('active');
    // Add your next step here (camera page, etc)
    console.log('Start camera scanning');
});

// Close modals when clicking outside
registerModal.addEventListener('click', (e) => {
    if (e.target === registerModal) {
        registerModal.classList.remove('active');
    }
});

qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) {
        qrModal.classList.remove('active');
    }
});

infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) {
        infoModal.classList.remove('active');
    }
});

instructionModal.addEventListener('click', (e) => {
    if (e.target === instructionModal) {
        instructionModal.classList.remove('active');
    }
});

// Check form validity
function checkFormValidity() {
    let allFilled = true;
    inputs.forEach(input => {
        if (!input.value.trim()) {
            allFilled = false;
        }
    });

    if (allFilled && privacyCheck.checked && promoCheck.checked) {
        btnNext.classList.add('active');
    } else {
        btnNext.classList.remove('active');
    }
}

// Add event listeners
inputs.forEach(input => {
    input.addEventListener('input', checkFormValidity);
});

privacyCheck.addEventListener('change', checkFormValidity);
promoCheck.addEventListener('change', checkFormValidity);

// Form submit
form.addEventListener('submit', (e) => {
    e.preventDefault();
    // Add your form submission logic here
    console.log('Form submitted');
});
