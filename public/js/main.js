// Landing page logic
(function () {
  const createBtn = document.getElementById('createMeetingBtn');
  const joinBtn = document.getElementById('joinMeetingBtn');
  const codeInput = document.getElementById('roomCodeInput');
  const nameModal = document.getElementById('nameModal');
  const displayNameInput = document.getElementById('displayNameInput');
  const modalCancelBtn = document.getElementById('modalCancelBtn');
  const modalJoinBtn = document.getElementById('modalJoinBtn');

  let targetRoomId = null;

  // Restore last used name
  const savedName = localStorage.getItem('meetup_displayName') || '';
  displayNameInput.value = savedName;

  // Enable/disable join button based on input
  codeInput.addEventListener('input', () => {
    const val = codeInput.value.trim();
    joinBtn.disabled = val.length < 3;
  });

  // Allow pasting full URLs
  codeInput.addEventListener('paste', (e) => {
    setTimeout(() => {
      let val = codeInput.value.trim();
      // Extract room ID from URL
      const match = val.match(/\/room\/([a-z]+-[a-z]+-[a-z]+)/);
      if (match) {
        codeInput.value = match[1];
      }
      joinBtn.disabled = codeInput.value.trim().length < 3;
    }, 0);
  });

  // Enter key on code input
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) {
      joinBtn.click();
    }
  });

  // Create meeting
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      const data = await res.json();
      targetRoomId = data.roomId;
      showNameModal();
    } catch (err) {
      alert('Failed to create meeting. Please try again.');
    } finally {
      createBtn.disabled = false;
    }
  });

  // Join meeting
  joinBtn.addEventListener('click', () => {
    let code = codeInput.value.trim();
    // Extract room ID from URL if pasted
    const match = code.match(/\/room\/([a-z]+-[a-z]+-[a-z]+)/);
    if (match) code = match[1];

    if (!code) return;
    targetRoomId = code;
    showNameModal();
  });

  function showNameModal() {
    nameModal.style.display = 'flex';
    displayNameInput.focus();
  }

  function hideNameModal() {
    nameModal.style.display = 'none';
    targetRoomId = null;
  }

  modalCancelBtn.addEventListener('click', hideNameModal);

  nameModal.addEventListener('click', (e) => {
    if (e.target === nameModal) hideNameModal();
  });

  displayNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalJoinBtn.click();
  });

  modalJoinBtn.addEventListener('click', () => {
    const name = displayNameInput.value.trim();
    if (!name) {
      displayNameInput.focus();
      displayNameInput.classList.add('input-error');
      setTimeout(() => displayNameInput.classList.remove('input-error'), 1500);
      return;
    }
    if (!targetRoomId) return;

    // Save name for next time
    localStorage.setItem('meetup_displayName', name);

    // Navigate to room
    window.location.href = `/room/${targetRoomId}?name=${encodeURIComponent(name)}`;
  });
})();
