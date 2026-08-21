// Clicking the toolbar icon opens the popup; this lets the side panel
// also be opened from the extension menu and keeps it enabled globally.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
