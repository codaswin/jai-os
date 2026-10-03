export type ManagerChatMessage = {
  role: 'user' | 'assistant' | 'error';
  text: string;
};
