document.addEventListener('DOMContentLoaded', function() {
    const checkbox = document.getElementById('agreeInstruction');
    const button = document.getElementById('btnUnderstand');

    button.disabled = true;
    button.style.opacity = '0.5';

    checkbox.addEventListener('change', function() {
        if (this.checked) {
            button.disabled = false;
            button.style.opacity = '1';
        } else {
            button.disabled = true;
            button.style.opacity = '0.5';
        }
    });

    button.addEventListener('click', function() {
        if (!checkbox.checked) {
            return;
        }
        // Replace 'halaman_upload.html' with your next page
        window.location.href = 'halaman_upload.html';
    });
});