const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copyPannel', {
  list: () => ipcRenderer.invoke('history:list'),
  restore: (id) => ipcRenderer.invoke('history:restore', id),
  hide: () => ipcRenderer.invoke('panel:hide'),
  toggleFavorite: (id) => ipcRenderer.invoke('history:toggleFavorite', id),
  delete: (id) => ipcRenderer.invoke('history:delete', id),
  clear: () => ipcRenderer.invoke('history:clear'),
  onPanelOpened: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('panel:opened', listener);
    return () => ipcRenderer.removeListener('panel:opened', listener);
  },
  onChanged: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  }
});
