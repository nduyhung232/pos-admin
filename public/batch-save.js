/*
 * batch-save.js — one "Save" button per screen, PATCH only what changed.
 *
 * Wiring (declarative, no per-page code):
 *   <div data-batch-form data-endpoint="/staff">        container
 *     <button data-batch-save>Lưu thay đổi</button>      the single save button
 *     <div data-batch-notice></div>                      where results are shown
 *     <tr data-row data-syncid="UUID">                   one editable record
 *       <input data-field="name">                        an editable field
 *       <input type="checkbox" data-field="active">
 *       <input data-field="pin" data-writeonly>          write-only (e.g. new PIN)
 *
 * On save we diff each field against its baseline and send ONLY changed rows
 * with ONLY their changed fields as { changes: [{ syncId, ...fields }] }.
 * Unchanged data is never re-transmitted (PATCH, not PUT).
 */
(function () {
  'use strict';

  var ERROR_MESSAGES = {
    invalid: 'Dữ liệu không hợp lệ.',
    pin_policy: 'PIN phải là 4–8 chữ số.',
    not_found: 'Một số bản ghi không còn tồn tại. Hãy tải lại trang.',
    last_manager: 'Không thể lưu: phải còn ít nhất một Quản lý đang hoạt động.',
    unauthorized: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
    forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  };

  function currentValue(el) {
    return el.type === 'checkbox' ? String(el.checked) : el.value;
  }

  function payloadValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  }

  function isWriteOnly(el) {
    return el.hasAttribute('data-writeonly');
  }

  function isDirty(el) {
    if (isWriteOnly(el)) return el.value.trim() !== '';
    return currentValue(el) !== el.dataset.batchOriginal;
  }

  function setDirtyStyle(el, dirty) {
    el.style.backgroundColor = dirty ? '#fff8e1' : '';
  }

  function showNotice(container, kind, message) {
    if (!container) return;
    var cls = { success: 'success', info: 'info', warning: 'warning', danger: 'danger' }[kind] || 'info';
    var icon = kind === 'success' ? 'check-circle' : kind === 'danger' || kind === 'warning' ? 'exclamation-triangle' : 'info-circle';
    container.innerHTML =
      '<div class="alert alert-' + cls + ' alert-dismissible py-2">' +
      '<i class="bi bi-' + icon + '"></i> ' + message +
      '<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>';
  }

  function initForm(form) {
    var endpoint = form.getAttribute('data-endpoint');
    var saveBtn = form.querySelector('[data-batch-save]');
    var notice = form.querySelector('[data-batch-notice]');
    var fields = Array.prototype.slice.call(form.querySelectorAll('[data-field]'));
    if (!endpoint || !saveBtn) return;

    // Capture the baseline for every non-write-only field.
    fields.forEach(function (el) {
      if (!isWriteOnly(el)) el.dataset.batchOriginal = currentValue(el);
      var handler = function () { setDirtyStyle(el, isDirty(el)); };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });

    saveBtn.addEventListener('click', function () {
      // Group dirty fields by their row's syncId.
      var rows = {};
      fields.forEach(function (el) {
        if (!isDirty(el)) return;
        var row = el.closest('[data-row]');
        if (!row) return;
        var id = row.getAttribute('data-syncid');
        if (!rows[id]) rows[id] = { syncId: id };
        rows[id][el.getAttribute('data-field')] = payloadValue(el);
      });
      var changes = Object.keys(rows).map(function (id) { return rows[id]; });

      if (changes.length === 0) {
        showNotice(notice, 'info', 'Không có thay đổi nào để lưu.');
        return;
      }

      saveBtn.disabled = true;
      var original = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Đang lưu…';

      fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ changes: changes }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { status: res.status, data: data };
          });
        })
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.data && r.data.ok) {
            var n = r.data.updated || 0;
            showNotice(notice, 'success', n === 0 ? 'Không có thay đổi nào để lưu.' : 'Đã lưu ' + n + ' thay đổi.');
            // Reset the baseline so subsequent edits diff against the saved state.
            fields.forEach(function (el) {
              if (isWriteOnly(el)) { el.value = ''; }
              else { el.dataset.batchOriginal = currentValue(el); }
              setDirtyStyle(el, false);
            });
          } else {
            var key = (r.data && (r.data.error || r.data.message)) || 'invalid';
            showNotice(notice, 'warning', ERROR_MESSAGES[key] || ('Lưu thất bại (' + key + ').'));
          }
        })
        .catch(function (e) {
          showNotice(notice, 'danger', 'Lỗi kết nối: ' + (e && e.message ? e.message : e));
        })
        .then(function () {
          saveBtn.disabled = false;
          saveBtn.innerHTML = original;
        });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.slice.call(document.querySelectorAll('[data-batch-form]')).forEach(initForm);
  });
})();
