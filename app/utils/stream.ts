// app/utils/stream.ts

// using tauri command to send request
// see src-tauri/src/stream.rs, and src-tauri/src/main.rs
// 1. invoke('stream_fetch', {url, method, headers, body}), get response with headers.
// 2. listen event: `stream-response` multi times to get body

type ResponseEvent = {
  id: number;
  payload: {
    request_id: number;
    status?: number;
    chunk?: number[]; // Assuming chunk is an array of bytes (u8)
  };
};

type StreamResponse = {
  request_id: number;
  status: number;
  status_text: string;
  headers: Record<string, string>;
};

// Helper function to convert various body types to Uint8Array and set Content-Type if needed
async function processBody(body: BodyInit | null | undefined, headers: Record<string, string>): Promise<number[]> {
  if (body === null || body === undefined) {
    return [];
  }

  // Handle common body types
  if (typeof body === 'string') {
    // If Content-Type is not set, default to text/plain for strings (but might be overridden)
    // It's better for the caller to set Content-Type explicitly.
    // if (!headers['Content-Type'] && !headers['content-type']) {
    //    headers['Content-Type'] = 'text/plain;charset=UTF-8';
    // }
    return Array.from(new TextEncoder().encode(body));
  }

  if (body instanceof URLSearchParams) {
     if (!headers['Content-Type'] && !headers['content-type']) {
       headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
     }
     return Array.from(new TextEncoder().encode(body.toString()));
  }

  if (body instanceof FormData) {
    // Tauri's invoke might have issues sending FormData directly or as complex objects.
    // Convert FormData to application/x-www-form-urlencoded string if no specific type is set.
    // Note: This doesn't support file uploads via application/form-data with boundaries easily.
    // For file uploads, consider using a different approach or backend handling.
    if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        // Convert FormData to URLSearchParams-like string
        const params = new URLSearchParams();
        // @ts-ignore - FormData.entries() exists
        for (const [key, value] of body.entries()) {
            params.append(key, value as string); // Simplified, doesn't handle multiple values or blobs perfectly
        }
        return Array.from(new TextEncoder().encode(params.toString()));
    } else {
        // If Content-Type is already set (e.g., multipart/form-data), you might need
        // a different serialization strategy or rely on Tauri backend to handle it.
        // This simple conversion might not be sufficient for multipart.
        const params = new URLSearchParams();
        // @ts-ignore - FormData.entries() exists
        for (const [key, value] of body.entries()) {
            params.append(key, value as string);
        }
        return Array.from(new TextEncoder().encode(params.toString()));
    }
  }

  // Handle Blob or ArrayBuffer (less common for typical POST data, but possible)
  if (body instanceof Blob) {
     if (!headers['Content-Type'] && !headers['content-type'] && body.type) {
        headers['Content-Type'] = body.type;
     }
     const buffer = await body.arrayBuffer();
     return Array.from(new Uint8Array(buffer));
  }

  if (body instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(body));
  }

  // If it's already an Uint8Array or similar view
  if (body instanceof Uint8Array) {
      return Array.from(body);
  }

  // Fallback: try to stringify if it's an object (not recommended practice, but sometimes used)
  // It's better to explicitly convert to JSON and set Content-Type before calling fetch.
  if (typeof body === 'object') {
      if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json;charset=UTF-8';
      }
      try {
          const jsonBody = JSON.stringify(body);
          return Array.from(new TextEncoder().encode(jsonBody));
      } catch (e) {
          console.error("Failed to stringify object body", e);
          return []; // Or throw error
      }
  }

  // Default case, try toString and encode (might not be ideal)
  console.warn("Unknown body type, converting to string", typeof body, body);
  return Array.from(new TextEncoder().encode(String(body)));

}

export async function fetch(url: string, options?: RequestInit): Promise<Response> { // Make function async
  if (window.__TAURI__) {
    const {
      signal,
      method = "GET", // Keep default GET, but expect caller to override for POST
      headers: _headers = {},
      body: originalBody = null, // Accept null/undefined body
    } = options || {};

    let unlisten: Function | undefined;
    let setRequestId: Function | undefined;
    const requestIdPromise = new Promise((resolve) => (setRequestId = resolve));
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unlisten && unlisten();
      writer.ready.then(() => {
        writer.close().catch((e) => console.error("Error closing writer:", e));
      }).catch(e => console.error("Error waiting for writer ready:", e));
    };

    if (signal) {
      signal.addEventListener("abort", () => {
         close();
         // Optionally reject a promise or handle abort logic if needed beyond closing stream
      });
    }

    // @ts-ignore 2. listen response multi times, and write to Response.body
    window.__TAURI__.event
      .listen("stream-response", (e: ResponseEvent) =>
        requestIdPromise.then((request_id) => {
          const { request_id: rid, chunk, status } = e?.payload || {};
          if (request_id != rid) {
            return;
          }
          if (chunk && chunk.length > 0) { // Check if chunk exists and has data
            writer.ready.then(() => {
              writer.write(new Uint8Array(chunk));
            }).catch(e => {
                console.error("Error writing chunk to stream:", e);
                close(); // Close on write error
            });
          } else if (status === 0) {
            // end of body
            close();
          }
        }).catch(e => console.error("Error in event listener promise chain:", e)),
      )
      .then((u: Function) => (unlisten = u))
      .catch((e: any) => { // Explicitly type the error parameter
          console.error("Failed to setup stream-response listener:", e);
          close(); // Close if listener setup fails
      });

    // Initialize headers object - Start with defaults, allow override
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      "User-Agent": navigator.userAgent,
    };

    // Copy over provided headers, overriding defaults if necessary
    const headerEntries = new Headers(_headers || {});
    for (const [key, value] of headerEntries) {
      // Standardize header names to title case or lowercase if needed by backend
      // Tauri/Wry usually handles this, but good to be aware
      headers[key] = value;
    }

    // Process the body and update headers if necessary (e.g., setting Content-Type)
    // This needs to be awaited
    const body = await processBody(originalBody, headers);

    // Ensure method is uppercase
    const normalizedMethod = method.toUpperCase();

    // --- DEBUG LOGGING --- (Remove or comment out in production)
    console.log("[Tauri Stream Fetch] URL:", url);
    console.log("[Tauri Stream Fetch] Method:", normalizedMethod);
    console.log("[Tauri Stream Fetch] Headers:", headers);
    // --- END DEBUG LOGGING ---

    return window.__TAURI__
      .invoke("stream_fetch", {
        method: normalizedMethod,
        url,
        headers, // Send the potentially modified headers
        body, // Send the processed body as number[]
      })
      .then((res: StreamResponse) => {
        const { request_id, status, status_text: statusText, headers: responseHeaders } = res;
        setRequestId?.(request_id);

        // Create the standard Response object
        const response = new Response(ts.readable, {
          status,
          statusText,
          headers: responseHeaders, // Use headers from the Tauri response
        });

        // Close the stream if the response indicates an error status
        // (This might already be handled by the status===0 event, but as a safeguard)
        if (status >= 400) { // Consider 4xx and 5xx as errors needing stream closure
          setTimeout(close, 100); // Delay slightly to allow any final data
        }

        return response;
      })
      .catch((e) => {
        console.error("Tauri stream_fetch error:", e);
        close(); // Ensure cleanup on error
        // Return a synthetic error response or re-throw
        // Returning a Response object matching fetch API error behavior is common
        return new Response("", { status: 599, statusText: "Tauri Stream Fetch Error" }); // Or throw e;
      });
  }

  // Fallback to native fetch if not in Tauri environment
  // Make sure the native fetch call also awaits if options might be async processed in the future
  // (Currently, native fetch handles body processing internally)
  return window.fetch(url, options);
}
