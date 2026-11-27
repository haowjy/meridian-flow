import { savePost } from "../store/posts.js";

export function publish(request) {
  return { id: savePost(request.body) };
}
