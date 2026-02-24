export async function callLineAPI(url, method, data, token, isImage = false) {
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
    };

    let body;

    if (method === 'POST' || method === 'PUT') {
      if (isImage) {
        body = data;
        headers['Content-Type'] = 'image/jpeg';
      } else {
        body = JSON.stringify(data);
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const raw = await response.text();
    let parsedResponse = null;

    try {
      parsedResponse = JSON.parse(raw);
    } catch {
      // Response might not be JSON
    }

    return {
      code: response.status,
      response: parsedResponse,
      raw,
    };
  } catch (error) {
    console.error('API call error:', error);
    return {
      code: 500,
      response: null,
      raw: error.message,
    };
  }
}

export async function getCurrentMenu(token) {
  return callLineAPI(
    'https://api.line.me/v2/bot/user/all/richmenu',
    'GET',
    null,
    token
  );
}

export async function listRichMenus(token) {
  return callLineAPI(
    'https://api.line.me/v2/bot/richmenu/list',
    'GET',
    null,
    token
  );
}

export async function createRichMenu(token, menuData) {
  return callLineAPI(
    'https://api.line.me/v2/bot/richmenu',
    'POST',
    menuData,
    token
  );
}

export async function uploadMenuImage(token, menuId, imageBuffer) {
  return callLineAPI(
    `https://api-data.line.me/v2/bot/richmenu/${menuId}/content`,
    'POST',
    imageBuffer,
    token,
    true
  );
}

export async function setDefaultMenu(token, menuId) {
  return callLineAPI(
    `https://api.line.me/v2/bot/user/all/richmenu/${menuId}`,
    'POST',
    {},
    token
  );
}

export async function deleteRichMenu(token, menuId) {
  return callLineAPI(
    `https://api.line.me/v2/bot/richmenu/${menuId}`,
    'DELETE',
    null,
    token
  );
}

export async function getRichMenuImage(token, menuId) {
  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${menuId}/content`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }

  return response;
}

export async function getBotInfo(token) {
  return callLineAPI(
    'https://api.line.me/v2/bot/info',
    'GET',
    null,
    token
  );
}