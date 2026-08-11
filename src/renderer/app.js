const state = {
  items: [],
  query: '',
  filter: 'all',
  selectedIndex: 0
};

const listEl = document.querySelector('#historyList');
const emptyEl = document.querySelector('#emptyState');
const searchInput = document.querySelector('#searchInput');
const countLabel = document.querySelector('#countLabel');
const clearButton = document.querySelector('#clearButton');
const hideButton = document.querySelector('#hideButton');
const filterButtons = [...document.querySelectorAll('.filter')];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function typeLabel(item) {
  if (item.type === 'text') return '文本';
  if (item.type === 'image') return '图片';
  if (item.type === 'video') return '视频';
  if (item.type === 'image-file') return '图片文件';
  if (item.type === 'media-file') return '媒体';
  return '文件';
}

function previewText(item) {
  if (item.type === 'text') return item.text;
  if (item.filePaths?.length) return item.filePaths.join('\n');
  return item.searchableText || item.title;
}

function itemBodyHtml(item) {
  if (item.type === 'image' && item.previewUrl) {
    return `
      <div class="image-content">
        <img alt="剪贴板图片" src="${escapeHtml(item.previewUrl)}" />
      </div>
    `;
  }

  return `
    <div class="item-content" title="${escapeHtml(previewText(item))}">${escapeHtml(previewText(item))}</div>
  `;
}

function matchesFilter(item) {
  if (state.filter === 'all') return true;
  if (state.filter === 'favorite') return item.favorite;
  if (state.filter === 'file') return ['file', 'image-file', 'media-file'].includes(item.type);
  if (state.filter === 'image') return ['image', 'image-file'].includes(item.type);
  return item.type === state.filter;
}

function filteredItems() {
  const tokens = state.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return state.items.filter((item) => {
    if (!matchesFilter(item)) return false;
    if (tokens.length === 0) return true;

    const haystack = [item.title, item.searchableText, item.text, ...(item.filePaths || [])]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();

    return tokens.every((token) => haystack.includes(token));
  });
}

function render() {
  const items = filteredItems();
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(items.length - 1, 0));
  countLabel.textContent = `${items.length} / ${state.items.length} 条记录`;
  emptyEl.hidden = items.length !== 0;

  listEl.innerHTML = items
    .map((item, index) => {
      const selectedClass = index === state.selectedIndex ? ' is-selected' : '';
      const imageClass = item.type === 'image' ? ' is-image' : '';
      const favoriteLabel = item.favorite ? '★' : '☆';
      return `
        <article class="history-item${selectedClass}${imageClass}" data-id="${escapeHtml(item.id)}">
          <div class="item-main">
            ${itemBodyHtml(item)}
            <div class="item-meta">
              <span class="pill">${typeLabel(item)}</span>
              <span>${escapeHtml(item.createdLabel)}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="item-action" type="button" data-action="favorite" title="收藏">${favoriteLabel}</button>
            <button class="item-action primary" type="button" data-action="restore" title="复制到剪贴板">↵</button>
            <button class="item-action danger" type="button" data-action="delete" title="删除">×</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function restoreByIndex(index) {
  const item = filteredItems()[index];
  if (!item) return;
  await window.copyPannel.restore(item.id);
  await window.copyPannel.hide();
}

searchInput.addEventListener('input', (event) => {
  state.query = event.target.value;
  state.selectedIndex = 0;
  render();
});

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    state.selectedIndex = 0;
    filterButtons.forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
    render();
  });
});

listEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  const itemEl = event.target.closest('.history-item');
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  if (!button) {
    await window.copyPannel.restore(id);
    await window.copyPannel.hide();
    return;
  }

  if (button.dataset.action === 'restore') {
    await window.copyPannel.restore(id);
    await window.copyPannel.hide();
  }
  if (button.dataset.action === 'favorite') await window.copyPannel.toggleFavorite(id);
  if (button.dataset.action === 'delete') await window.copyPannel.delete(id);
});

clearButton.addEventListener('click', async () => {
  await window.copyPannel.clear();
});

hideButton.addEventListener('click', async () => {
  await window.copyPannel.hide();
});

document.addEventListener('keydown', async (event) => {
  const items = filteredItems();
  if (event.key === 'Escape') {
    event.preventDefault();
    await window.copyPannel.hide();
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(items.length - 1, 0));
    render();
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
    render();
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    await restoreByIndex(state.selectedIndex);
  }
});

window.copyPannel.onPanelOpened(() => {
  state.query = '';
  state.selectedIndex = 0;
  searchInput.value = '';
  render();
  requestAnimationFrame(() => searchInput.focus());
});

window.copyPannel.onChanged((items) => {
  state.items = items;
  render();
});

window.copyPannel.list().then((items) => {
  state.items = items;
  render();
});
