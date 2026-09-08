package core

import (
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Pi-parity context pipeline: transcript vivo -> contexto derivado.
//
// Em pi (packages/agent/src/harness/session/context.ts) a montagem do
// que vai para o LLM e um pipeline puro:
//
//	AgentMessage[] (transcript vivo)
//	  -> filtra isMeta
//	  -> resolve toolResult -> tool_result blocks
//	  -> injeta system reminders
//	  -> transformContext(state, messages)  <- ponto de extensao
//	  -> ApiMessage[] para model.call()
//
// O daemon fazia tudo inline em oneTurn (copy -> PruneOldToolResults ->
// repair -> mirror condicional -> Request). Este ficheiro extrai essa
// montagem para um pipeline testavel e empilhavel, sem tocar no
// transcript vivo (a.messages).
//
// Ordem do pipeline (BuildContext):
//
//	1. snapshot do transcript vivo
//	2. filterHidden  - remove mensagens Meta["hidden"]="true" (pi: isMeta)
//	3. PruneOldToolResults - trunca outputs antigos mecanicamente
//	4. repairToolUseResultPairs - stub p/ tool_use orfao (abort)
//	5. Transforms[] - injecao derivada por turno (AGENTS.md, skills,
//	   memoria). Nao persiste: o transcript mantem o original.
//	6. mirrorImagesForProvider - espelho de imagens p/ openai/openai-codex
//	   (antes persistia no transcript; agora e derivado por turno)
//	7. injectReminders - avisos sinteticos nao persistidos (queued,
//	   compaction, approvals)
//
// Tudo o que os passos 5-7 produzem existe so no request. O que
// persiste (SessionStore / OnMessageAppended) continua a ser o
// transcript vivo.

// Meta keys com semantica no pipeline de contexto.
const (
	// MetaHidden marca mensagens que existem no transcript (e na
	// persistencia) mas nunca vao para o LLM. Equivalente ao isMeta
	// do pi: status interno, espelhos legados, linhas de controlo.
	MetaHidden = "hidden"
	// MetaEphemeral marca mensagens sinteticas produzidas pelo
	// pipeline (reminders, mirrors). Existem so no request; nunca
	// devem ser persistidas nem re-injetadas no transcript.
	MetaEphemeral = "ephemeral"
	// MetaImageMirror marca o espelho de imagens gerado para
	// providers text-centric (openai/openai-codex). Sessões antigas
	// podem ter o espelho persistido no transcript; o filtro trata
	// esses casos por prefixo de texto (ver filterHidden).
	MetaImageMirror = "image_mirror"
)

// imageMirrorPrefix e o prefixo historico do espelho persistido no
// transcript (ver mirrorToolImagesAsUser). Mantido para filtrar
// espelhos legados em sessoes antigas; espelhos novos sao derivados
// por turno e nunca persistem.
const imageMirrorPrefix = "Tool output included the following image content:"

// ContextTransformer e o equivalente Go do transformContext do pi:
// recebe as mensagens montadas ate aqui e devolve as mensagens
// transformadas. Transformacoes tipicas: injecao de AGENTS.md,
// skills, memoria de projeto, reescrita de texto visivel.
//
// Regras:
//   - Nao mutar o slice de entrada; devolver slice novo ou o mesmo.
//   - Nunca persistir: o resultado existe so no request.
//   - Manter pares tool_call/tool_result intactos (nao remover um
//     lado do par).
type ContextTransformer func(msgs []provider.Message) []provider.Message

// AssistantTextTransform reescreve o texto visivel de uma mensagem do
// assistente (supressao ou substituicao). Substitui o antigo hook
// BeforeAssistantMessage: em vez de um hook com semantica propria, a
// reescrita vira um transform empilhavel sobre o texto.
//
// Retorna (replacement, ok): ok=false suprime a emissao visivel;
// replacement != "" substitui o texto emitido. O transcript (e o que
// o modelo ve nos proximos turnos) mantem sempre o original.
type AssistantTextTransform func(text string) (replacement string, ok bool)

// Reminder e um aviso sintetico injetado no contexto do turno, sem
// persistir. Equivalente aos system reminders do pi (pending
// approvals, compaction reminders, queued messages).
type Reminder struct {
	// Text e o corpo do aviso.
	Text string
	// Meta carrega marcadores (ex. {"reminder": "queued"}).
	// MetaEphemeral=true e forcado na emissao.
	Meta map[string]string
}

// filterHidden remove do contexto mensagens marcadas como internas.
// Equivalente ao filtro isMeta do pi em buildContextMessages.
//
// Filtra:
//   - Meta[MetaHidden]=="true"
//   - espelhos de imagem legados persistidos (MetaImageMirror ou o
//     prefixo historico como unica/texto inicial), porque o espelho
//     agora e derivado por turno via mirrorImagesForProvider e seria
//     duplicado no request.
func filterHidden(msgs []provider.Message) []provider.Message {
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Meta != nil && m.Meta[MetaHidden] == "true" {
			continue
		}
		if m.Meta != nil && m.Meta[MetaImageMirror] == "true" {
			continue
		}
		if m.Role == provider.RoleUser && isLegacyImageMirror(m) {
			continue
		}
		out = append(out, m)
	}
	return out
}

// isLegacyImageMirror detecta o espelho de imagens persistido por
// builds antigos (runLoop anexava mirrorToolImagesAsUser ao
// transcript). O espelho historico e uma user message cujo texto
// começa pelo prefixo canonico.
func isLegacyImageMirror(m provider.Message) bool {
	for _, c := range m.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			if strings.HasPrefix(tb.Text, imageMirrorPrefix) {
				return true
			}
		}
	}
	return false
}

// mirrorImagesForProvider deriva o espelho de imagens de tool results
// como mensagem sinteticas de turno, sem persistir. Antes o runLoop
// anexava o espelho ao transcript vivo (poluindo historico e
// compaction); agora o espelho existe so no request.
//
// Retorna nil quando o provider consome imagens em tool messages
// nativamente ou quando nao ha imagens. O chamador anexa o
// resultado apos a ultima mensagem.
func mirrorImagesForProvider(clientName string, msgs []provider.Message) *provider.Message {
	if clientName != "openai" && clientName != "openai-codex" {
		return nil
	}
	if len(msgs) == 0 {
		return nil
	}
	last := msgs[len(msgs)-1]
	if last.Role != provider.RoleTool {
		return nil
	}
	mirror := mirrorToolImagesAsUser(last)
	if len(mirror.Content) == 0 {
		return nil
	}
	mirror.Meta = map[string]string{MetaEphemeral: "true", MetaImageMirror: "true"}
	mirror.Time = time.Now()
	return &mirror
}

// injectReminders anexa reminders como user messages sinteticas no fim
// do contexto, marcadas MetaEphemeral. Nao persiste, nao altera o
// transcript, nao participa de cut points de compaction.
func injectReminders(msgs []provider.Message, reminders []Reminder) []provider.Message {
	if len(reminders) == 0 {
		return msgs
	}
	out := make([]provider.Message, 0, len(msgs)+len(reminders))
	out = append(out, msgs...)
	now := time.Now()
	for _, r := range reminders {
		if strings.TrimSpace(r.Text) == "" {
			continue
		}
		meta := map[string]string{MetaEphemeral: "true"}
		for k, v := range r.Meta {
			meta[k] = v
		}
		out = append(out, provider.Message{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: r.Text}},
			Time:    now,
			Meta:    meta,
		})
	}
	return out
}

// applyAssistantTextTransforms aplica AssistantTextTransforms sobre o
// texto da mensagem para emissao visivel. Devolve (emit, suppress):
// suppress=true significa nao emitir EvAssistantMessage. O transcript
// nao e tocado — o chamador persiste sempre o original.
func applyAssistantTextTransforms(msg provider.Message, transforms []AssistantTextTransform) (provider.Message, bool) {
	if len(transforms) == 0 {
		return msg, false
	}
	orig := extractText(msg)
	if orig == "" {
		return msg, false
	}
	emit := msg
	for _, t := range transforms {
		if t == nil {
			continue
		}
		replacement, ok := t(orig)
		if !ok {
			return msg, true
		}
		if replacement != "" && replacement != orig {
			emit = replaceText(emit, replacement)
			orig = replacement
		}
	}
	return emit, false
}
