import Cookie from 'js-cookie'

type Credentials = {
  apiKey: {
    id: string;
    key: string;
  };
  machineId: string;
  host: string;
}

export function getMachineKeyFromURL(): string | undefined {
  return window.location.pathname.split('/')[2]
}

export function getCredentialsFromCookie(machineKey: string): Credentials {
  const { apiKey, machineId, hostname } = JSON.parse(Cookie.get(machineKey))
  return {
    apiKey,
    machineId,
    host: hostname
  }
}