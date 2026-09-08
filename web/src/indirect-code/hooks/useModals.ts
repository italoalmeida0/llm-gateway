import { createSignal, onCleanup } from "solid-js";
import { api, type RemotePairDto } from "../../api";
import type { ChoiceOption, ConfirmState } from "../viewTypes";

/** Promise-based modals (choice/confirm) + pairing (extracted from
 * RemoteCodePage without behavioral changes). */
export function createModals(opts: { toast: (message: string, kind?: "ok" | "err") => void }) {
  // Choice modal: like showConfirm but returns the picked option id
  // (or null on cancel). Used for fork-vs-resend on edit/regenerate.
  const [choiceState, setChoiceState] = createSignal<{ title: string; message: string; options: ChoiceOption[]; resolve: (id: string | null) => void } | null>(null);
  function showChoice(opts: { title: string; message: string; options: ChoiceOption[] }): Promise<string | null> {
    return new Promise((resolve) => {
      setChoiceState({ ...opts, resolve: (id) => { setChoiceState(null); resolve(id); } });
    });
  }

  // Promise-based confirm modal (chatbot showConfirm, no native confirm()).
  const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);
  function showConfirm(opts: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmState({
        title: opts.title || "Confirm",
        message: opts.message || "",
        confirmText: opts.confirmText || "Confirm",
        cancelText: opts.cancelText || "Cancel",
        danger: !!opts.danger,
        resolve,
      });
    });
  }

  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairingData, setPairingData] = createSignal<RemotePairDto | null>(null);
  const [pairingLoading, setPairingLoading] = createSignal(false);

  async function generatePairingToken() {
    setPairingLoading(true);
    try {
      const res = await api<RemotePairDto>("POST", "/api/indirect-code/pair");
      setPairingData(res);
      setShowPairModal(true);
    } catch (err: any) {
      opts.toast("Pairing request failed: " + (err?.message || err), "err");
    } finally {
      setPairingLoading(false);
    }
  }

  onCleanup(() => {
    confirmState()?.resolve(false);
  });

  return {
    choiceState, showChoice,
    confirmState, setConfirmState, showConfirm,
    showPairModal, setShowPairModal,
    pairingData, pairingLoading, generatePairingToken,
  };
}

export type Modals = ReturnType<typeof createModals>;
