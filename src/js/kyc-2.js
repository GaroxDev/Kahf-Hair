document.addEventListener('DOMContentLoaded', function() {
    const options = document.querySelectorAll('.option');
    const nextBtn = document.querySelector('.btn-next');
    
    options.forEach(option => {
        option.addEventListener('click', function () {
            options.forEach(opt => {
                opt.style.border = '3px solid transparent'; 
            });
            this.style.border = '3px solid #c8ff00';
            nextBtn.classList.add('active');
        });
    });

    // Prevent clicking "NEXT" if not active
    const nextLink = document.querySelector('a[href="kyc-3.html"]');
    nextLink.addEventListener('click', function(event) {
        if (!nextBtn.classList.contains('active')) {
            event.preventDefault();
        }
    });
});