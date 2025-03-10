/*
Copyright 2012 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/* import-globals-from preserve-referer.js */

"use strict";

var VIEWER_URL = chrome.extension.getURL("content/web/viewer.html");

function getViewerURL(pdf_url) {
  // |pdf_url| may contain a fragment such as "#page=2". That should be passed
  // as a fragment to the viewer, not encoded in pdf_url.
  var hash = "";
  var i = pdf_url.indexOf("#");
  if (i > 0) {
    hash = pdf_url.slice(i);
    pdf_url = pdf_url.slice(0, i);
  }
  return VIEWER_URL + "?file=" + encodeURIComponent(pdf_url) + hash;
}

/**
 * @param {Object} details First argument of the webRequest.onHeadersReceived
 *                         event. The property "url" is read.
 * @returns {boolean} True if the PDF file should be downloaded.
 */
function isPdfDownloadable(details) {
  if (details.url.includes("pdfjs.action=download")) {
    return true;
  }
  // Display the PDF viewer regardless of the Content-Disposition header if the
  // file is displayed in the main frame, since most often users want to view
  // a PDF, and servers are often misconfigured.
  // If the query string contains "=download", do not unconditionally force the
  // viewer to open the PDF, but first check whether the Content-Disposition
  // header specifies an attachment. This allows sites like Google Drive to
  // operate correctly (#6106).
  if (details.type === "main_frame" && !details.url.includes("=download")) {
    return false;
  }
  var cdHeader =
    details.responseHeaders &&
    getHeaderFromHeaders(details.responseHeaders, "content-disposition");
  return cdHeader && /^attachment/i.test(cdHeader.value);
}

/**
 * Get the header from the list of headers for a given name.
 * @param {Array} headers responseHeaders of webRequest.onHeadersReceived
 * @returns {undefined|{name: string, value: string}} The header, if found.
 */
function getHeaderFromHeaders(headers, headerName) {
  for (const header of headers) {
    if (header.name.toLowerCase() === headerName) {
      return header;
    }
  }
  return undefined;
}

/**
 * Check if the request is a PDF file.
 * @param {Object} details First argument of the webRequest.onHeadersReceived
 *                         event. The properties "responseHeaders" and "url"
 *                         are read.
 * @returns {boolean} True if the resource is a PDF file.
 */
function isPdfFile(details) {
  var header = getHeaderFromHeaders(details.responseHeaders, "content-type");
  if (header) {
    var headerValue = header.value.toLowerCase().split(";", 1)[0].trim();
    if (headerValue === "application/pdf") {
      return true;
    }
    if (headerValue === "application/octet-stream") {
      if (details.url.toLowerCase().indexOf(".pdf") > 0) {
        return true;
      }
      var cdHeader = getHeaderFromHeaders(
        details.responseHeaders,
        "content-disposition"
      );
      if (cdHeader && /\.pdf(["']|$)/i.test(cdHeader.value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Takes a set of headers, and set "Content-Disposition: attachment".
 * @param {Object} details First argument of the webRequest.onHeadersReceived
 *                         event. The property "responseHeaders" is read and
 *                         modified if needed.
 * @returns {Object|undefined} The return value for the onHeadersReceived event.
 *                             Object with key "responseHeaders" if the headers
 *                             have been modified, undefined otherwise.
 */
function getHeadersWithContentDispositionAttachment(details) {
  var headers = details.responseHeaders;
  var cdHeader = getHeaderFromHeaders(headers, "content-disposition");
  if (!cdHeader) {
    cdHeader = { name: "Content-Disposition" };
    headers.push(cdHeader);
  }
  if (!/^attachment/i.test(cdHeader.value)) {
    cdHeader.value = "attachment" + cdHeader.value.replace(/^[^;]+/i, "");
    return { responseHeaders: headers };
  }
  return undefined;
}

chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    if (details.method !== "GET") {
      // Don't intercept POST requests until http://crbug.com/104058 is fixed.
      return undefined;
    }
    if (!isPdfFile(details)) {
      return undefined;
    }
    if (isPdfDownloadable(details)) {
      // Force download by ensuring that Content-Disposition: attachment is set
      return getHeadersWithContentDispositionAttachment(details);
    }

    var viewerUrl = getViewerURL(details.url);

    // Implemented in preserve-referer.js
    saveReferer(details);

    return { redirectUrl: viewerUrl };
  },
  {
    urls: ["<all_urls>"],
    types: ["main_frame", "sub_frame"],
  },
  ["blocking", "responseHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (isPdfDownloadable(details)) {
      return undefined;
    }

    var viewerUrl = getViewerURL(details.url);

    return { redirectUrl: viewerUrl };
  },
  {
    urls: ["file://*/*.pdf", "file://*/*.PDF"],
    types: ["main_frame", "sub_frame"],
  },
  ["blocking"]
);

// Rewrite moz-extension://.../[pdf-url] back to moz-extension://.../content/web/viewer.html?file=...
// This is needed in Firefox since WebRequest url rewriting doesn't work with moz-extension://.  
if (VIEWER_URL.startsWith('moz-extension://')) {
  const extension_root = chrome.extension.getURL("")
  const extension_pdf_url_pattern = new RegExp("^" + extension_root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^&#]*://")
  chrome.webNavigation.onBeforeNavigate.addListener(
    function (details) {
      if (details.frameId !== 0 || details.url.startsWith(VIEWER_URL) || isPdfDownloadable(details))
        return;
      if (!extension_pdf_url_pattern.exec(details.url))
        return;
      chrome.tabs.update(details.tabId, {
        url: getViewerURL(details.url.slice(extension_root.length)),
      });
    },
    {
      url: [
        {
          urlPrefix: "moz-extension://",
        },
      ],
    }
  )
}

chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {
  if (isAllowedAccess) {
    return;
  }
  // If the user has not granted access to file:-URLs, then the webRequest API
  // will not catch the request. It is still visible through the webNavigation
  // API though, and we can replace the tab with the viewer.
  // The viewer will detect that it has no access to file:-URLs, and prompt the
  // user to activate file permissions.
  chrome.webNavigation.onBeforeNavigate.addListener(
    function (details) {
      if (details.frameId === 0 && !isPdfDownloadable(details)) {
        chrome.tabs.update(details.tabId, {
          url: getViewerURL(details.url),
        });
      }
    },
    {
      url: [
        {
          urlPrefix: "file://",
          pathSuffix: ".pdf",
        },
        {
          urlPrefix: "file://",
          pathSuffix: ".PDF",
        },
      ],
    }
  );
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.action === "getParentOrigin") {
    // getParentOrigin is used to determine whether it is safe to embed a
    // sensitive (local) file in a frame.
    if (!sender.tab) {
      sendResponse("");
      return undefined;
    }
    // TODO: This should be the URL of the parent frame, not the tab. But
    // chrome-extension:-URLs are not visible in the webNavigation API
    // (https://crbug.com/326768), so the next best thing is using the tab's URL
    // for making security decisions.
    var parentUrl = sender.tab.url;
    if (!parentUrl) {
      sendResponse("");
      return undefined;
    }
    if (parentUrl.lastIndexOf("file:", 0) === 0) {
      sendResponse("file://");
      return undefined;
    }
    // The regexp should always match for valid URLs, but in case it doesn't,
    // just give the full URL (e.g. data URLs).
    var origin = /^[^:]+:\/\/[^/]+/.exec(parentUrl);
    sendResponse(origin ? origin[1] : parentUrl);
    return true;
  }
  if (message && message.action === "isAllowedFileSchemeAccess") {
    chrome.extension.isAllowedFileSchemeAccess(sendResponse);
    return true;
  }
  if (message && message.action === "openExtensionsPageForFileAccess") {
    var url = "chrome://extensions/?id=" + chrome.runtime.id;
    if (message.data.newTab) {
      chrome.tabs.create({
        windowId: sender.tab.windowId,
        index: sender.tab.index + 1,
        url,
        openerTabId: sender.tab.id,
      });
    } else {
      chrome.tabs.update(sender.tab.id, {
        url,
      });
    }
  }
  return undefined;
});
