document.addEventListener('DOMContentLoaded', function() {
    const options = document.querySelectorAll('.option');
    const nextBtn = document.querySelector('.btn-next');
    let optionSelected = false;

    options.forEach(option => {
        option.addEventListener('click', function () {
            options.forEach(opt => {
                opt.style.border = 'none';
            });
            this.style.border = '3px solid #c8ff00';
            nextBtn.classList.add('active');
            optionSelected = true;
        });
    });

    nextBtn.addEventListener('click', function () {
        if (nextBtn.classList.contains('active')) {
            window.location.href = 'kyc-2.html';
        }
    });
});