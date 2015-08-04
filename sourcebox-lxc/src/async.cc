#include "async.h"

using namespace v8;

AsyncWorker::AsyncWorker(lxc_container *container, NanCallback *callback)
    : NanAsyncWorker(callback), container_(container) { }

void LxcWorker::Execute() {
    if (!lxc_container_get(container_)) {
        SetErrorMessage("Invalid container reference");
        return;
    }

    if (!container_->may_control(container_)) {
        SetErrorMessage("Insufficient privileges to control container");
    } else if (!container_->is_defined(container_)) {
        SetErrorMessage("Container is not defined");
    } else {
        LxcExecute();
    }

    lxc_container_put(container_);
}