const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------- helpers
function setStep(name) {
  $$('.step').forEach(el => {
    el.classList.remove('active', 'done');
    const order = ['login', 'channels', 'download'];
    if (order.indexOf(el.dataset.step) < order.indexOf(name)) el.classList.add('done');
    if (el.dataset.step === name) el.classList.add('active');
  });
  $$('.panel').forEach(el => el.classList.remove('active'));
  $(`#panel-${name}`).classList.add('active');
}

function showBtnLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector('.btn-label')?.classList.toggle('hidden', loading);
  btn.querySelector('.spinner')?.classList.toggle('hidden', !loading);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) { $(id).classList.add('hidden'); }

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const AVATAR_COLORS = [
  'linear-gradient(135deg,#6d8cff,#8f6dff)',
  'linear-gradient(135deg,#3ddc97,#29b579)',
  'linear-gradient(135deg,#ffb347,#ff7d47)',
  'linear-gradient(135deg,#ff6b6b,#ff478f)',
  'linear-gradient(135deg,#47c6ff,#478fff)',
  'linear-gradient(135deg,#c96dff,#8f6dff)',
];
function colorFor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function initialsFor(title) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
function timeAgo(iso) {
  if (!iso) return 'no activity';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ================================================================ AUTH
let pendingPhone = null;

$('#btn-send-code').addEventListener('click', async () => {
  hideError('#err-login');
  const api_id = $('#api_id').value.trim();
  const api_hash = $('#api_hash').value.trim();
  const phone = $('#phone').value.trim();
  if (!api_id || !api_hash || !phone) {
    showError('#err-login', 'Please fill in all three fields.');
    return;
  }
  const btn = $('#btn-send-code');
  showBtnLoading(btn, true);
  try {
    const data = await api('/api/send_code', { api_id, api_hash, phone });
    pendingPhone = phone;
    if (data.status === 'already_authorized') {
      goToChannels();
    } else {
      $('#card-otp').classList.remove('hidden');
      $('#otp').focus();
    }
  } catch (e) {
    showError('#err-login', e.message);
  } finally {
    showBtnLoading(btn, false);
  }
});

$('#btn-verify-code').addEventListener('click', async () => {
  hideError('#err-otp');
  const code = $('#otp').value.trim();
  if (!code) { showError('#err-otp', 'Enter the code Telegram sent you.'); return; }
  const btn = $('#btn-verify-code');
  showBtnLoading(btn, true);
  try {
    const data = await api('/api/verify_code', { code });
    if (data.status === 'need_password') {
      $('#card-password').classList.remove('hidden');
      $('#tfa_password').focus();
    } else {
      goToChannels();
    }
  } catch (e) {
    showError('#err-otp', e.message);
  } finally {
    showBtnLoading(btn, false);
  }
});

$('#btn-verify-password').addEventListener('click', async () => {
  hideError('#err-password');
  const password = $('#tfa_password').value;
  if (!password) { showError('#err-password', 'Enter your cloud password.'); return; }
  const btn = $('#btn-verify-password');
  showBtnLoading(btn, true);
  try {
    await api('/api/verify_password', { password });
    goToChannels();
  } catch (e) {
    showError('#err-password', e.message);
  } finally {
    showBtnLoading(btn, false);
  }
});

['#api_id', '#api_hash', '#phone'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-send-code').click(); })
);
$('#otp').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-verify-code').click(); });
$('#tfa_password').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-verify-password').click(); });

// ================================================================ CHANNELS
let channels = [];
let selected = new Set();

function goToChannels() {
  setStep('channels');
  loadChannels();
}

$('#btn-refresh-channels').addEventListener('click', loadChannels);

async function loadChannels() {
  $('#channel-grid').innerHTML = '';
  $('#channel-grid').classList.add('hidden');
  $('#channel-skeleton').classList.remove('hidden');
  selected.clear();
  updateSelectionUI();

  try {
    const data = await api('/api/channels');
    channels = data.channels;
    renderChannels(channels);
    lazyLoadExtras(channels);
  } catch (e) {
    $('#channel-skeleton').classList.add('hidden');
    $('#channel-grid').classList.remove('hidden');
    $('#channel-grid').innerHTML = `<div class="muted">Couldn't load channels: ${e.message}</div>`;
  }
}

function channelCardHtml(ch) {
  const initials = initialsFor(ch.title);
  const bg = colorFor(ch.id);
  const badges = [];
  badges.push(`<span class="badge channel-type">${ch.kind}</span>`);
  if (!ch.username) badges.push(`<span class="badge no-username">No username</span>`);
  if (ch.verified) badges.push(`<span class="badge verified">✓ Verified</span>`);
  if (ch.creator) badges.push(`<span class="badge creator">Owner</span>`);
  else if (ch.is_admin) badges.push(`<span class="badge admin">Admin</span>`);
  if (ch.content_protected) badges.push(`<span class="badge protected">Content protected</span>`);
  if (ch.scam || ch.fake) badges.push(`<span class="badge scam">⚠ ${ch.scam ? 'Scam' : 'Fake'}</span>`);
  if (ch.unread_count > 0) badges.push(`<span class="badge unread">${ch.unread_count} unread</span>`);

  return `
    <div class="channel-card" data-id="${ch.id}">
      <div class="avatar" style="background:${bg}" data-avatar-for="${ch.id}">
        <span class="avatar-initials">${initials}</span>
        <div class="ring"></div>
      </div>
      <div class="channel-body">
        <div class="channel-top-row">
          <div class="channel-title" title="${escapeHtml(ch.title)}">${escapeHtml(ch.title)}</div>
          <div class="check"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 4.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        </div>
        <div class="channel-meta-row">${badges.join('')}</div>
        <div class="channel-sub" data-sub-for="${ch.id}">
          <span>${timeAgo(ch.last_message_date)}</span>
          <span class="loading-dots">Loading details</span>
        </div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderChannels(list) {
  $('#channel-skeleton').classList.add('hidden');
  const grid = $('#channel-grid');
  grid.classList.remove('hidden');
  if (list.length === 0) {
    grid.innerHTML = `<div class="muted">No channels or groups found on this account.</div>`;
    return;
  }
  grid.innerHTML = list.map(channelCardHtml).join('');

  grid.querySelectorAll('.channel-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      card.classList.toggle('selected');
      updateSelectionUI();
    });
  });
}

function updateSelectionUI() {
  $('#selection-count').textContent = `${selected.size} selected`;
  $('#btn-start-download').disabled = selected.size === 0;
  $('#select-all').checked = selected.size > 0 && selected.size === channels.length;
}

$('#select-all').addEventListener('change', (e) => {
  const grid = $('#channel-grid');
  if (e.target.checked) {
    channels.forEach(ch => selected.add(ch.id));
  } else {
    selected.clear();
  }
  grid.querySelectorAll('.channel-card').forEach(card => {
    card.classList.toggle('selected', selected.has(card.dataset.id));
  });
  updateSelectionUI();
});

$('#channel-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = channels.filter(ch => ch.title.toLowerCase().includes(q));
  renderChannels(filtered);
  filtered.forEach(ch => {
    const card = document.querySelector(`.channel-card[data-id="${ch.id}"]`);
    if (card) card.classList.toggle('selected', selected.has(ch.id));
  });
  updateSelectionUI();
});

// Progressive enhancement: fetch avatar photo + member count/about for each
// card without blocking the initial render. Small concurrency limit so we
// don't hammer Telegram's API or the local server.
async function lazyLoadExtras(list) {
  const CONCURRENCY = 4;
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const ch = list[idx++];
      await Promise.all([loadPhoto(ch), loadDetails(ch)]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function loadPhoto(ch) {
  if (!ch.has_photo) return;
  try {
    const data = await api(`/api/channel_photo/${ch.id}`);
    if (data.photo) {
      const el = document.querySelector(`[data-avatar-for="${ch.id}"]`);
      if (el) {
        el.innerHTML = `<img src="${data.photo}" alt=""><div class="ring"></div>`;
      }
    }
  } catch (e) { /* silent - keep initials avatar */ }
}

async function loadDetails(ch) {
  try {
    const data = await api(`/api/channel_details/${ch.id}`);
    const el = document.querySelector(`[data-sub-for="${ch.id}"]`);
    if (!el) return;
    const parts = [timeAgo(ch.last_message_date)];
    if (data.participants_count != null) {
      parts.push(`${data.participants_count.toLocaleString()} members`);
    }
    if (data.slowmode_seconds) {
      parts.push(`slow mode ${data.slowmode_seconds}s`);
    }
    el.innerHTML = parts.map(p => `<span>${escapeHtml(p)}</span>`).join('');
  } catch (e) {
    const el = document.querySelector(`[data-sub-for="${ch.id}"]`);
    if (el) el.innerHTML = `<span>${timeAgo(ch.last_message_date)}</span>`;
  }
}

// folder browse
$('#btn-choose-folder').addEventListener('click', async () => {
  const btn = $('#btn-choose-folder');
  btn.disabled = true;
  try {
    const data = await api('/api/choose_folder', {});
    if (data.folder) $('#download-folder').value = data.folder;
  } catch (e) { /* silent, user can type manually */ }
  finally { btn.disabled = false; }
});

// ================================================================ DOWNLOAD
let currentJobId = null;
let channelAvatarCache = {};

$('#btn-start-download').addEventListener('click', async () => {
  const folder = $('#download-folder').value.trim();
  const channel_ids = Array.from(selected);
  setStep('download');
  resetProgressUI(channel_ids.length);

  try {
    const data = await api('/api/download', { channel_ids, folder });
    currentJobId = data.job_id;
    listenToProgress(currentJobId);
  } catch (e) {
    setStagePill('error', 'Error');
    $('#stage-title').textContent = 'Could not start download';
    logLine(e.message, 'err');
  }
});

function resetProgressUI(totalChannels) {
  $('#stage-title').textContent = 'Connecting...';
  setStagePill('active', 'Starting');
  $('#overall-fill').style.width = '0%';
  $('#overall-percent').textContent = '0%';
  $('#overall-label').textContent = `0 of ${totalChannels} channels`;
  $('#channel-fill').style.width = '0%';
  $('#ccb-name').textContent = '-';
  $('#ccb-sub').textContent = 'Waiting to start...';
  $('#ccb-avatar').textContent = '?';
  $('#stat-media').textContent = '0';
  $('#stat-text').textContent = '0';
  $('#stat-scanned').textContent = '0';
  $('#log-console').innerHTML = '';
  $('#btn-open-folder').classList.add('hidden');
  const stopBtn = $('#btn-stop-download');
  stopBtn.classList.remove('hidden');
  stopBtn.disabled = false;
  stopBtn.querySelector('.btn-label').textContent = 'Stop';
}

function setStagePill(kind, text) {
  const el = $('#stage-pill');
  el.className = 'stage-pill' + (kind === 'done' ? ' done' : kind === 'error' ? ' error' : '');
  el.textContent = text;
}

function logLine(text, kind) {
  const el = $('#log-console');
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'log-line' + (kind ? ` ${kind}` : '');
  div.innerHTML = `<span class="t">${time}</span>${escapeHtml(text)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function updateOverallForChannel(data, channelFraction) {
  if (!data.total_channels || !data.index) return;
  const safeFraction = Math.max(0, Math.min(1, channelFraction || 0));
  let pct = Math.min(100, Math.round((((data.index - 1) + safeFraction) / data.total_channels) * 100));
  if (pct === 0 && safeFraction > 0) pct = 1;
  $('#overall-fill').style.width = `${pct}%`;
  $('#overall-percent').textContent = `${pct}%`;
  $('#overall-label').textContent = `${data.index - 1} of ${data.total_channels} channels`;
}

function listenToProgress(jobId) {
  const src = new EventSource(`/api/progress/${jobId}`);

  src.addEventListener('message', (evt) => {
    const data = JSON.parse(evt.data);
    handleProgressEvent(data);
  });

  src.addEventListener('end', () => {
    src.close();
  });

  src.onerror = () => {
    // EventSource auto-retries; if the job already ended this is a no-op.
  };
}

function handleProgressEvent(data) {
  switch (data.type) {
    case 'job_start':
      $('#stage-title').textContent = 'Backing up your channels...';
      setStagePill('active', 'Downloading');
      $('#overall-label').textContent = `0 of ${data.total_channels} channels`;
      break;

    case 'channel_start': {
      $('#ccb-name').textContent = data.name;
      $('#ccb-avatar').textContent = initialsFor(data.name);
      $('#ccb-sub').textContent = 'Scanning message history...';
      $('#channel-fill').style.width = '0%';
      $('#stat-media').textContent = '0';
      $('#stat-text').textContent = '0';
      $('#stat-scanned').textContent = '0';
      logLine(`Starting "${data.name}" (${data.index}/${data.total_channels})`);
      const overallPct = Math.round(((data.index - 1) / data.total_channels) * 100);
      $('#overall-fill').style.width = `${overallPct}%`;
      $('#overall-percent').textContent = `${overallPct}%`;
      $('#overall-label').textContent = `${data.index - 1} of ${data.total_channels} channels`;
      break;
    }

    case 'channel_total':
      $('#ccb-sub').textContent = data.total_messages
        ? `0 of ${data.total_messages.toLocaleString()} messages`
        : 'Scanning message history...';
      break;

    case 'channel_progress': {
      $('#stat-media').textContent = data.media_downloaded.toLocaleString();
      $('#stat-text').textContent = data.text_saved.toLocaleString();
      $('#stat-scanned').textContent = data.scanned.toLocaleString();
      if (data.total_messages) {
        const channelFraction = Math.min(1, data.scanned / data.total_messages);
        const pct = Math.min(100, Math.round(channelFraction * 100));
        $('#channel-fill').style.width = `${pct}%`;
        $('#ccb-sub').textContent = `${data.scanned.toLocaleString()} of ${data.total_messages.toLocaleString()} messages - ${pct}%`;
        updateOverallForChannel(data, channelFraction);
      } else {
        $('#ccb-sub').textContent = `${data.scanned.toLocaleString()} messages scanned`;
      }
      break;
    }

    case 'media_progress': {
      $('#stat-media').textContent = data.media_downloaded.toLocaleString();
      $('#stat-text').textContent = data.text_saved.toLocaleString();
      $('#stat-scanned').textContent = data.scanned.toLocaleString();

      if (data.total_messages) {
        const downloaded = Number(data.downloaded_bytes || 0);
        const total = Number(data.total_bytes || 0);
        const fileFraction = total ? Math.min(1, downloaded / total) : 0;
        const completedBeforeThisMessage = Math.max(0, data.scanned - 1);
        const channelFraction = (completedBeforeThisMessage + fileFraction) / data.total_messages;
        const channelPct = Math.min(
          100,
          Math.max(1, Math.round(channelFraction * 100))
        );
        $('#channel-fill').style.width = `${channelPct}%`;
        updateOverallForChannel(data, channelFraction);
      } else {
        $('#channel-fill').style.width = `${Math.max(1, data.percent)}%`;
      }

      const filePct = Math.max(0, Math.min(100, data.percent || 0));
      const sizeText = data.total_bytes
        ? `${formatBytes(data.downloaded_bytes)} of ${formatBytes(data.total_bytes)}`
        : formatBytes(data.downloaded_bytes);
      $('#ccb-sub').textContent = `Downloading message ${data.message_id}: ${filePct}% (${sizeText})`;
      break;
    }

    case 'flood_wait':
      logLine(`Telegram asked us to slow down - waiting ${data.seconds}s (this is normal for large channels)`, 'err');
      $('#ccb-sub').textContent = `Rate limited - resuming in ${data.seconds}s...`;
      break;

    case 'media_error':
      logLine(`Couldn't download one item in "${data.name}" (message ${data.message_id}): ${data.error}`, 'err');
      break;

    case 'channel_done': {
      $('#channel-fill').style.width = '100%';
      logLine(`Finished "${data.name}" - ${data.media_downloaded} files, ${data.text_saved} messages logged`, 'ok');
      const overallPct = Math.round((data.index / data.total_channels) * 100);
      $('#overall-fill').style.width = `${overallPct}%`;
      $('#overall-percent').textContent = `${overallPct}%`;
      $('#overall-label').textContent = `${data.index} of ${data.total_channels} channels`;
      break;
    }

    case 'cancelled':
      logLine(`Stopped during "${data.name}" - files downloaded so far are kept`, 'err');
      break;

    case 'job_cancelled':
      setStagePill('error', 'Stopped');
      $('#stage-title').textContent = 'Backup stopped';
      $('#ccb-sub').textContent = 'Stopped by you. Anything already downloaded is safely saved.';
      $('#btn-stop-download').classList.add('hidden');
      $('#btn-open-folder').classList.remove('hidden');
      break;

    case 'job_done':
      $('#stage-title').textContent = 'Backup complete';
      setStagePill('done', 'Done');
      $('#ccb-sub').textContent = 'All selected channels backed up.';
      $('#btn-stop-download').classList.add('hidden');
      $('#btn-open-folder').classList.remove('hidden');
      logLine('All done. Your files are saved locally.', 'ok');
      break;

    case 'job_error':
      setStagePill('error', 'Error');
      $('#stage-title').textContent = 'Something went wrong';
      logLine(data.error, 'err');
      $('#btn-stop-download').classList.add('hidden');
      break;
  }
}

$('#btn-stop-download').addEventListener('click', async () => {
  if (!currentJobId) return;
  const btn = $('#btn-stop-download');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Stopping...';
  logLine('Stop requested - finishing the current file, then halting...');
  try { await api(`/api/cancel/${currentJobId}`, {}); } catch (e) {}
});

$('#btn-open-folder').addEventListener('click', () => {
  const folder = $('#download-folder').value.trim() || './telegram_backup';
  alert(`Your files are saved at:\n${folder}\n\n(Browsers can't open a Finder window directly - navigate there manually.)`);
});
