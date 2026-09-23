import { Address, ClientPublicTestnet, WitnessArgs } from "@ckb-ccc/ccc";
import "./style.css";

const RPC_URL = "https://testnet.ckb.dev/rpc";
const RECIPIENT = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdrcaufs8qeu8wvvy0myyedek4vqad9qeq3gc4cf";
const TRANSFER = 128n * 100_000_000n;
const FEE_RESERVE = 100_000n;
const client = new ClientPublicTestnet({ url: RPC_URL });

const elements = {
  accountState: document.querySelector("#account-state"),
  accountAddress: document.querySelector("#account-address"),
  balance: document.querySelector("#balance"),
  connectButton: document.querySelector("#connect-button"),
  signButton: document.querySelector("#sign-button"),
  status: document.querySelector("#status"),
  log: document.querySelector("#log"),
};

let accountAddress = null;
let accountScript = null;

function formatCkb(shannons) {
  const whole = shannons / 100_000_000n;
  const fraction = (shannons % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function toHex(value) {
  return `0x${value.toString(16)}`;
}

function log(message) {
  const line = document.createElement("div");
  line.className = "log-line log-line-new";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  line.append(time, text);
  elements.log.append(line);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function provider() {
  return window.ckb;
}

async function requestAccounts() {
  if (!provider?.()) throw new Error("未检测到 ckb-tw Provider，请在 Chrome 中加载插件后刷新页面。");
  const accounts = await provider().request({ method: "ckb_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error("钱包没有返回可用地址。");
  return accounts[0];
}

async function connectWallet() {
  elements.connectButton.disabled = true;
  setStatus("正在请求钱包地址…");
  try {
    accountAddress = await requestAccounts();
    accountScript = (await Address.fromString(accountAddress, client)).script;
    elements.accountState.textContent = "钱包已连接";
    elements.accountAddress.textContent = accountAddress;
    elements.signButton.disabled = false;
    elements.connectButton.textContent = "已连接";
    log(`Provider 返回地址 ${accountAddress.slice(0, 12)}…${accountAddress.slice(-8)}`);
    await refreshBalance();
    setStatus("已准备好构造交易", "success");
  } catch (error) {
    setStatus(error.message, "error");
    log(`连接失败：${error.message}`);
  } finally {
    elements.connectButton.disabled = false;
  }
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `${method} failed`);
  return payload.result;
}

function searchKey() {
  return {
    script: {
      code_hash: accountScript.codeHash,
      hash_type: accountScript.hashType,
      args: accountScript.args,
    },
    script_type: "lock",
  };
}

async function getCells() {
  const cells = [];
  let cursor;
  while (true) {
    const params = [searchKey(), "asc", "0x64"];
    if (cursor) params.push(cursor);
    const page = await rpc("get_cells", params);
    cells.push(...page.objects);
    if (page.objects.length === 0 || !page.last_cursor || page.last_cursor === cursor) break;
    cursor = page.last_cursor;
  }
  return cells.filter((cell) => cell.output.type == null);
}

async function refreshBalance() {
  const cells = await getCells();
  const total = cells.reduce((sum, cell) => sum + BigInt(cell.output.capacity), 0n);
  elements.balance.textContent = `${formatCkb(total)} CKB`;
  log(`RPC 找到 ${cells.length} 个 live cell，可用 ${formatCkb(total)} CKB`);
}

async function buildTransaction() {
  const recipientScript = (await Address.fromString(RECIPIENT, client)).script;
  const cells = await getCells();
  let selected = [];
  let inputCapacity = 0n;
  for (const cell of cells) {
    selected.push(cell);
    inputCapacity += BigInt(cell.output.capacity);
    if (inputCapacity >= TRANSFER + FEE_RESERVE) break;
  }
  if (inputCapacity < TRANSFER + FEE_RESERVE) {
    throw new Error(`余额不足：需要至少 ${formatCkb(TRANSFER + FEE_RESERVE)} CKB，当前 ${formatCkb(inputCapacity)} CKB。`);
  }
  const change = inputCapacity - TRANSFER - FEE_RESERVE;
  const sighashScript = client.scripts["Secp256k1Blake160"];
  if (!sighashScript?.cellDeps?.length) throw new Error("CKB Testnet Sighash dependency is unavailable.");
  const transaction = {
    version: "0x0",
    cellDeps: sighashScript.cellDeps.map(({ cellDep }) => cellDep),
    headerDeps: [],
    inputs: selected.map((cell) => ({
      since: "0x0",
      previousOutput: { txHash: cell.out_point.tx_hash, index: cell.out_point.index },
    })),
    outputs: [
      { capacity: toHex(TRANSFER), lock: recipientScript },
      { capacity: toHex(change), lock: accountScript },
    ],
    outputsData: ["0x", "0x"],
    witnesses: selected.map((_, index) => index === 0
      ? WitnessArgs.from({ lock: `0x${"00".repeat(65)}` }).toBytes()
      : "0x"),
  };
  console.log("Unsigned CKB transaction:", JSON.stringify(transaction, null, 2));
  return { transaction, selected, change };
}

async function requestSignature() {
  elements.signButton.disabled = true;
  setStatus("正在查询 live cells…");
  try {
    const { transaction, selected, change } = await buildTransaction();
    log(`构造交易：${selected.length} 个输入，找零 ${formatCkb(change)} CKB`);
    setStatus("请在 ckb-tw 弹窗中确认签名…");
    const signed = await provider().request({ method: "ckb_signTransaction", params: [transaction] });
    log("钱包已返回签名交易，正在提交到 CKB Testnet…");
    setStatus("正在广播签名交易…");
    const transactionHash = await client.sendTransaction(signed);
    const explorerLink = document.createElement("a");
    explorerLink.href = `https://pudge.explorer.nervos.org/transaction/${encodeURIComponent(transactionHash)}`;
    explorerLink.target = "_blank";
    explorerLink.rel = "noreferrer";
    explorerLink.textContent = "在区块浏览器中查看 ↗";
    elements.status.replaceChildren(document.createTextNode(`交易已广播：${transactionHash} `), explorerLink);
    elements.status.dataset.kind = "success";
    log(`交易已广播：${transactionHash}`);
    try {
      await refreshBalance();
    } catch (error) {
      log(`余额刷新失败：${error.message}`);
    }
  } catch (error) {
    setStatus(error.message, "error");
    log(`签名流程结束：${error.message}`);
  } finally {
    elements.signButton.disabled = false;
  }
}

elements.connectButton.addEventListener("click", connectWallet);
elements.signButton.addEventListener("click", requestSignature);

if (provider()) {
  log("检测到 window.ckb");
} else {
  log("未检测到 window.ckb");
}
