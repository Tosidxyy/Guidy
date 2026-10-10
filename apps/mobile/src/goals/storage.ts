import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { DRAFT_KEY, parseDraft, type GoalDraft } from './draft';

// Device draft is deliberately separate from account data and never auto-uploaded.
export async function readDraft(): Promise<GoalDraft | null> {
  const raw = Platform.OS === 'web' ? localStorage.getItem(DRAFT_KEY) : await SecureStore.getItemAsync(DRAFT_KEY);
  return parseDraft(raw);
}

export async function saveDraft(draft: GoalDraft): Promise<void> {
  const raw = JSON.stringify(draft);
  parseDraft(raw);
  if (Platform.OS === 'web') localStorage.setItem(DRAFT_KEY, raw);
  else await SecureStore.setItemAsync(DRAFT_KEY, raw);
}

export async function deleteDraft(): Promise<void> {
  if (Platform.OS === 'web') localStorage.removeItem(DRAFT_KEY);
  else await SecureStore.deleteItemAsync(DRAFT_KEY);
}
