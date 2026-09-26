package core

import "context"

type toolCallContextKey struct{}
type executionContextKey struct{}

func WithToolCallID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, toolCallContextKey{}, id)
}
func ToolCallID(ctx context.Context) string {
	id, _ := ctx.Value(toolCallContextKey{}).(string)
	return id
}
func WithExecutionID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, executionContextKey{}, id)
}
func ExecutionID(ctx context.Context) string {
	id, _ := ctx.Value(executionContextKey{}).(string)
	return id
}
