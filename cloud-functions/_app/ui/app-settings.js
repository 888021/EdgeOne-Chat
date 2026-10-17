// 偏好设置弹窗、微信 ClawBot 通道弹窗（含防盗绑管理员鉴权）与底部开关接线（内嵌页面分片；只允许字符串导出）
export default `  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');
  const accessTokenSetting = document.getElementById('accessTokenSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }
  if (accessTokenSetting) {
    accessTokenSetting.value = accessToken;
  }

  function openSettings() {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10);
  }

  settingsToggle.addEventListener('click', openSettings);

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    if (accessTokenSetting) {
      accessToken = accessTokenSetting.value.trim();
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

  // ===== 微信 ClawBot (iLink) 通道管理与防盗绑鉴权 =====
  const WX_ADMIN_TOKEN_KEY = 'eochat_wx_admin_token';
  let wxAdminToken = localStorage.getItem(WX_ADMIN_TOKEN_KEY) || '';

  const wxModal = document.getElementById('wxModal');
  const wxModalToggle = document.getElementById('wxModalToggle');
  const closeWxModalBtn = document.getElementById('closeWxModalBtn');
  const wxAdminTokenInput = document.getElementById('wxAdminTokenInput');
  const wxVerifyAdminBtn = document.getElementById('wxVerifyAdminBtn');
  const wxStatusBox = document.getElementById('wxStatusBox');
  const wxQrArea = document.getElementById('wxQrArea');
  const wxQrStatusText = document.getElementById('wxQrStatusText');
  const wxQrImg = document.getElementById('wxQrImg');
  const wxQrDirectLink = document.getElementById('wxQrDirectLink');
  const wxGetQrBtn = document.getElementById('wxGetQrBtn');
  const wxPollNowBtn = document.getElementById('wxPollNowBtn');
  const wxLogoutBtn = document.getElementById('wxLogoutBtn');
  const wxLivePollToggle = document.getElementById('wxLivePollToggle');

  if (wxAdminTokenInput) {
    wxAdminTokenInput.value = wxAdminToken;
  }

  let wxQrPollTimer = null;
  let wxLivePollActive = localStorage.getItem('eochat_wx_live_poll') === '1';
  let wxLiveLoopRunning = false;

  function buildWxAuthHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (accessToken) h['X-Access-Token'] = accessToken;
    const adm = (wxAdminTokenInput && wxAdminTokenInput.value.trim()) || wxAdminToken || accessToken;
    if (adm) h['X-Wx-Admin-Token'] = adm;
    return h;
  }

  function stopWxQrPolling() {
    if (wxQrPollTimer) {
      clearInterval(wxQrPollTimer);
      wxQrPollTimer = null;
    }
  }

  function setWxButtonsEnabled(enabled, isConnected) {
    if (wxGetQrBtn) wxGetQrBtn.disabled = !enabled || !!isConnected;
    if (wxPollNowBtn) wxPollNowBtn.disabled = !enabled;
    if (wxLogoutBtn) wxLogoutBtn.style.display = (enabled && isConnected) ? 'inline-block' : 'none';
  }

  async function refreshWxStatus() {
    if (!wxStatusBox) return;
    if (wxAdminTokenInput) {
      wxAdminToken = wxAdminTokenInput.value.trim();
      if (wxAdminToken) localStorage.setItem(WX_ADMIN_TOKEN_KEY, wxAdminToken);
      else localStorage.removeItem(WX_ADMIN_TOKEN_KEY);
    }
    try {
      const res = await fetch('/api/wx/status', { headers: buildWxAuthHeaders() });
      const data = await res.json();
      if (!data || !data.adminAuthorized) {
        setWxButtonsEnabled(false, false);
        wxStatusBox.innerHTML = '🔒 <b>防盗绑安全锁定中</b><br>' +
          escapeHtml((data && data.authReason) || '请在上方输入正确的管理员密钥 (WX_ADMIN_SECRET 或 ACCESS_PASSWORD) 并点击「验证」以解锁。') +
          (data && data.connected ? '<br>（当前通道状态：已绑定并受保护，外人无法查看或覆盖）' : '');
        return;
      }
      if (data.connected) {
        setWxButtonsEnabled(true, true);
        wxStatusBox.innerHTML = '✅ <b>状态：已连接微信 ClawBot（已加锁防覆盖）</b>' +
          '<br>机器人 ID：' + escapeHtml(data.botId || '-') +
          '<br>唯一授权微信号：' + escapeHtml(data.userId || '等待首次发消息激活') +
          '<br>绑定方式：' + (data.source === 'env' ? '环境变量 WX_BOT_TOKEN 锁定' : 'Blob/KV 扫码持久化') +
          (data.r2Bound ? '<br>持久化：存储已接通（凭证与上下文永久保存）' : '<br>⚠️ 提示：未绑定存储，实例重启后需重新扫码');
      } else if (data.expired) {
        setWxButtonsEnabled(true, false);
        if (wxLogoutBtn) wxLogoutBtn.style.display = 'inline-block';
        wxStatusBox.innerHTML = '⚠️ <b>状态：会话已过期 (ret=-14)</b><br>' +
          escapeHtml(data.errmsg || '请点击下方「扫码绑定微信 ClawBot」重新扫码授权。');
      } else {
        setWxButtonsEnabled(true, false);
        wxStatusBox.innerHTML = '⚪ <b>状态：未绑定（管理员已解锁）</b><br>点击下方「📱 扫码绑定微信 ClawBot」生成二维码，用手机微信扫码后将自动锁定为你本人专属。';
      }
    } catch (e) {
      wxStatusBox.textContent = '⚠️ 获取状态失败：' + (e && e.message ? e.message : String(e));
    }
  }

  if (wxVerifyAdminBtn) {
    wxVerifyAdminBtn.addEventListener('click', refreshWxStatus);
  }

  async function startWxQrBinding() {
    stopWxQrPolling();
    if (wxGetQrBtn) wxGetQrBtn.disabled = true;
    if (wxQrArea) wxQrArea.style.display = 'block';
    if (wxQrStatusText) wxQrStatusText.textContent = '⏳ 正在向微信 iLink 请求登录二维码…';
    try {
      const res = await fetch('/api/wx/qrcode', {
        method: 'POST',
        headers: buildWxAuthHeaders(),
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok || !data || !data.ok || !data.qrcode) {
        if (wxQrStatusText) wxQrStatusText.textContent = '⚠️ ' + ((data && data.error) || '获取二维码失败，请先验证管理员密钥');
        if (wxGetQrBtn) wxGetQrBtn.disabled = false;
        return;
      }
      const qrCodeKey = data.qrcode;
      const qrContentUrl = data.qrcode_img_content || '';
      if (wxQrImg && qrContentUrl) {
        wxQrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qrContentUrl);
      }
      if (wxQrDirectLink && qrContentUrl) {
        wxQrDirectLink.href = qrContentUrl;
      }
      if (wxQrStatusText) wxQrStatusText.textContent = '📱 请使用手机微信扫描二维码并在手机上点击确认';

      wxQrPollTimer = setInterval(async () => {
        try {
          const stRes = await fetch('/api/wx/qrcode-status?qrcode=' + encodeURIComponent(qrCodeKey), {
            headers: buildWxAuthHeaders()
          });
          const stData = await stRes.json();
          if (stData && stData.status === 'rejected') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '🚫 ' + (stData.error || '非白名单微信号，已拒绝绑定');
            if (wxGetQrBtn) wxGetQrBtn.disabled = false;
            return;
          }
          if (!stData || !stData.ok) return;
          if (stData.status === 'scaned') {
            if (wxQrStatusText) wxQrStatusText.textContent = '📲 已扫码！请在手机微信上点击「确认连接」…';
          } else if (stData.status === 'confirmed') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '🎉 绑定成功并已自动加锁！现在可以在手机微信 ClawBot 中直接发消息对话了。';
            await refreshWxStatus();
          } else if (stData.status === 'expired') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '⌛ 二维码已过期，请重新点击「扫码绑定微信 ClawBot」获取。';
            if (wxGetQrBtn) wxGetQrBtn.disabled = false;
          }
        } catch (e) {}
      }, 2200);
    } catch (e) {
      if (wxQrStatusText) wxQrStatusText.textContent = '⚠️ 请求异常：' + (e && e.message ? e.message : String(e));
      if (wxGetQrBtn) wxGetQrBtn.disabled = false;
    }
  }

  async function triggerManualWxPoll() {
    if (!wxPollNowBtn) return;
    const origText = wxPollNowBtn.textContent;
    wxPollNowBtn.disabled = true;
    wxPollNowBtn.textContent = '⏳ 同步中…';
    try {
      const res = await fetch('/api/wx/poll', {
        method: 'POST',
        headers: buildWxAuthHeaders(),
        body: JSON.stringify({ timeout_ms: 8000, single_shot: true })
      });
      const data = await res.json();
      if (data && data.ok) {
        wxPollNowBtn.textContent = '✅ 已处理 ' + (data.processed || 0) + ' 条';
      } else {
        wxPollNowBtn.textContent = '⚠️ ' + ((data && (data.error || data.message)) || '未就绪');
      }
      await refreshWxStatus();
    } catch (e) {
      wxPollNowBtn.textContent = '⚠️ 失败';
    } finally {
      setTimeout(() => {
        if (wxPollNowBtn) {
          wxPollNowBtn.disabled = false;
          wxPollNowBtn.textContent = origText;
        }
      }, 2000);
    }
  }

  async function runWxLivePollLoop() {
    if (wxLiveLoopRunning) return;
    wxLiveLoopRunning = true;
    while (wxLivePollActive) {
      if (document.hidden) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      try {
        const res = await fetch('/api/wx/poll', {
          method: 'POST',
          headers: buildWxAuthHeaders(),
          body: JSON.stringify({ timeout_ms: 18000, single_shot: true })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403 || (data && (data.expired || data.reason === 'not_configured'))) {
          await new Promise(r => setTimeout(r, 10000));
        } else {
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    wxLiveLoopRunning = false;
  }

  if (wxLivePollToggle) {
    wxLivePollToggle.checked = wxLivePollActive;
    wxLivePollToggle.addEventListener('change', () => {
      wxLivePollActive = wxLivePollToggle.checked;
      try { localStorage.setItem('eochat_wx_live_poll', wxLivePollActive ? '1' : '0'); } catch (e) {}
      if (wxLivePollActive) runWxLivePollLoop();
    });
    if (wxLivePollActive) runWxLivePollLoop();
  }

  if (wxModalToggle && wxModal) {
    wxModalToggle.addEventListener('click', () => {
      wxModal.style.display = 'flex';
      setTimeout(() => wxModal.classList.add('active'), 10);
      refreshWxStatus();
    });
  }
  if (closeWxModalBtn && wxModal) {
    closeWxModalBtn.addEventListener('click', () => {
      stopWxQrPolling();
      wxModal.classList.remove('active');
      setTimeout(() => wxModal.style.display = 'none', 300);
    });
  }
  if (wxModal) {
    wxModal.addEventListener('click', (e) => {
      if (e.target === wxModal && closeWxModalBtn) closeWxModalBtn.click();
    });
  }
  if (wxGetQrBtn) wxGetQrBtn.addEventListener('click', startWxQrBinding);
  if (wxPollNowBtn) wxPollNowBtn.addEventListener('click', triggerManualWxPoll);
  if (wxLogoutBtn) {
    wxLogoutBtn.addEventListener('click', async () => {
      stopWxQrPolling();
      try {
        await fetch('/api/wx/logout', { method: 'POST', headers: buildWxAuthHeaders() });
        if (wxQrArea) wxQrArea.style.display = 'none';
        await refreshWxStatus();
      } catch (e) {}
    });
  }

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);

  // 左下角「自动朗读」开关
  const ttsToggleBtn = document.getElementById('ttsToggle');
  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(TTS_AUTO_KEY, autoSpeak ? '1' : '0');
      if (!autoSpeak) stopSpeaking();
      updateTtsToggleUI();
    });
  }
  updateTtsToggleUI();

  // 页面关闭 / 切换标签页时停止朗读
  window.addEventListener('beforeunload', stopSpeaking);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });

`;
