"use strict";

const uuid = id => "0000" + id + "-0000-1000-8000-00805f9b34fb";
const UART = uuid("18f0");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FRAME_ID = "4F3";
const FRAME_INTERVAL_MS = 457;

function localTime(now) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes()];
}

function encodeClock([year, month, day, hour, minute]) {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) {
    throw new Error("Выберите дату в диапазоне 2000–2099.");
  }
  return [3, 3, 0, 1, 1, 0].map(flag =>
    [year - 2000, month, day, hour, minute, 0, flag, 0]
      .map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(""));
}

async function configure(exchange) {
  async function ok(command) {
    const reply = await exchange(command);
    const lines = reply.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    if (lines[0]?.replace(/\s/g, "").toUpperCase() === command.replace(/ /g, "")) {
      lines.shift();
    }
    if (lines.join("\n").toUpperCase() !== "OK") {
      throw new Error(command + " → " + (reply || "пустой ответ"));
    }
  }
  await ok("AT D");
  await ok("AT E0");
  await ok("AT L0");
  await ok("STP 51");
  if (await exchange("STPR") !== "51") {
    throw new Error("Адаптер не подтвердил протокол MS-CAN 51.");
  }
  if (await exchange("STPBRR") !== "125000") {
    throw new Error("Адаптер не подтвердил скорость 125 кбит/с.");
  }
  await ok("AT R0");
  await ok("AT SH " + FRAME_ID);
}

const byId = id => document.getElementById(id);
const connect = byId("connect");
const send = byId("send");
const status = byId("status");
const phone = byId("phone");
const date = byId("date");
const time = byId("time");
const connectionStatus = byId("connection");
let link = null;
let busy = false;

function render() {
  connect.disabled = busy || !navigator.bluetooth;
  connect.textContent = link ? "Отключить адаптер" : "Подключить адаптер";
  connectionStatus.textContent = link ? (link.device.name || "vLinker") + " · BLE"
    : busy ? "Подключение…" : "Не подключён";
  phone.disabled = busy;
  date.disabled = time.disabled = busy || phone.checked;
  if (phone.checked && !busy) refreshClockFields();
  send.disabled = busy || !link || (!phone.checked && (!date.checkValidity() || !time.checkValidity()));
}

function refreshClockFields() {
  const [year, month, day, hour, minute] = localTime(new Date()).map(value => String(value).padStart(2, "0"));
  date.value = year + "-" + month + "-" + day;
  time.value = hour + ":" + minute;
}

function closeLink(connection) {
  if (!connection) return;
  connection.closed = true;
  if (link === connection) link = null;
  connection.pending?.reject(new Error("Соединение BLE закрыто."));
  connection.rx?.removeEventListener("characteristicvaluechanged", connection.onData);
  connection.device.removeEventListener("gattserverdisconnected", connection.onDisconnect);
  if (connection.device.gatt.connected) connection.device.gatt.disconnect();
}

function exchange(connection, command) {
  if (connection.closed || !connection.device.gatt.connected) {
    return Promise.reject(new Error("Соединение с vLinker прервано."));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Нет ответа на " + command)), 5000);
    function finish(error) {
      clearTimeout(timeout);
      connection.pending = null;
      if (error) reject(error);
      else resolve(pending.text.split(">")[0].trim());
    }
    const pending = { text: "", written: false, reject: finish, complete() {
      if (this.written && this.text.includes(">")) finish();
    }};
    connection.pending = pending;

    Promise.resolve().then(() => {
      const bytes = encoder.encode(command + "\r");
      const tx = connection.tx;
      if (tx.properties.write && typeof tx.writeValueWithResponse === "function") {
        return tx.writeValueWithResponse(bytes);
      }
      if (!tx.properties.write && typeof tx.writeValueWithoutResponse === "function") {
        return tx.writeValueWithoutResponse(bytes);
      }
      return tx.writeValue(bytes);
    }).then(() => {
      if (connection.pending !== pending) return;
      pending.written = true;
      pending.complete();
    }).catch(error => {
      if (connection.pending === pending) finish(error);
    });
  });
}

phone.addEventListener("change", render);
date.addEventListener("input", render);
time.addEventListener("input", render);

connect.addEventListener("click", async () => {
  if (busy) return;
  if (link) {
    closeLink(link);
    status.textContent = "Адаптер отключён.";
    render();
    return;
  }
  busy = true;
  render();
  let candidate;
  let timeout;
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UART] }, { namePrefix: "vLinker" }, { namePrefix: "VLINKER" }],
      optionalServices: [UART]
    });
    candidate = { device, pending: null, closed: false };
    candidate.onDisconnect = () => {
      closeLink(candidate);
      if (!busy) status.textContent = "Соединение с vLinker прервано.";
      render();
    };
    candidate.onData = event => {
      const pending = candidate.pending;
      if (!pending || pending.text.includes(">")) return;
      pending.text += decoder.decode(event.target.value);
      if (pending.text.length > 2048) pending.reject(new Error("Слишком длинный ответ vLinker."));
      else pending.complete();
    };
    device.addEventListener("gattserverdisconnected", candidate.onDisconnect);
    status.textContent = "Подключение к vLinker…";
    const setup = async () => {
      const server = await device.gatt.connect();
      if (candidate.closed) {
        server.disconnect();
        throw new Error("Подключение закрыто.");
      }
      const service = await server.getPrimaryService(UART);
      const rx = await service.getCharacteristic(uuid("2af0"));
      const tx = await service.getCharacteristic(uuid("2af1"));
      if (candidate.closed) throw new Error("Подключение закрыто.");
      candidate.rx = rx;
      candidate.tx = tx;
      rx.addEventListener("characteristicvaluechanged", candidate.onData);
      await rx.startNotifications();
    };
    await Promise.race([setup(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Тайм-аут подключения BLE.")), 12000);
    })]);
    if (candidate.closed) throw new Error("vLinker отключился при подключении.");
    link = candidate;
    status.textContent = "Готово к отправке.";
  } catch (error) {
    closeLink(candidate);
    status.textContent = "Подключение не удалось. " + error.message;
  } finally {
    clearTimeout(timeout);
    busy = false;
    render();
  }
});

byId("clock").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !link) return;
  const selected = phone.checked ? localTime(new Date())
    : [...date.value.split("-"), ...time.value.split(":")].map(Number);
  const connection = link;
  busy = true;
  render();
  let attempted = false;
  try {
    const payloads = encodeClock(selected);
    status.textContent = "Проверка протокола и скорости MS-CAN…";
    const command = value => exchange(connection, value);
    await configure(command);
    status.textContent = "Отправка даты и времени…";
    for (const payload of payloads) {
      if (attempted) await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS));
      attempted = true;
      const reply = await command(payload);
      if (reply && reply.toUpperCase() !== "OK") throw new Error(reply);
    }
    status.textContent = "Кадры даты и времени отправлены. Проверьте приборку.";
  } catch (error) {
    closeLink(connection);
    status.textContent = (attempted ? "Отправка не подтверждена. Проверьте часы на приборке. "
      : "Кадр часов не отправлен. ") + error.message;
  } finally {
    busy = false;
    render();
  }
});

if (!navigator.bluetooth) {
  status.textContent = "Web Bluetooth недоступен. Откройте HTTPS-адрес в Bluefy на iPhone или в Chrome на Android.";
}
render();
setInterval(() => {
  if (!busy && phone.checked) refreshClockFields();
}, 1000);
