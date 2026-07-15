import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../client.js'
import { normalizePersona, normalizeReferral } from '../pages/admin/Helpers.js'
import { slugify } from '../pages/student/Helpers.js'

// case-form's submit flow
export function useCaseSubmit({ isEditMode, editCaseId }) {
    const [submitError, setSubmitError] = useState('')
    const [submitSuccess, setSubmitSuccess] = useState('')

    // Update Case
    const saveMutation = useMutation({
        mutationFn: (payload) =>
            apiFetch(isEditMode ? `/api/cases/${editCaseId}` : '/api/cases', {
                method: isEditMode ? 'PUT' : 'POST',
                body: payload,
            }),
        onSuccess: () =>
            setSubmitSuccess(isEditMode ? 'Case updated successfully.' : 'Case saved successfully.'),
        onError: (error) => {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        },
    })

    // Upload + save.
    const submitCase = async ({
        caseName,
        initialBrief,
        commonInformation,
        simulationDurationMinutes,
        accessCode,
        totalPersonas,
        personas,
    }) => {
        setSubmitError('')
        setSubmitSuccess('')

        const buildPrefix = () => {
            const slug = slugify(caseName)
            return slug ? `cases/${slug}` : 'cases'
        }

        const uploadFile = async (file, prefix) => {
            const presign = await apiFetch('/api/uploads/presign', {
                method: 'POST',
                body: {file_name: file.name, content_type: file.type || null, prefix},
            })

            const putResponse = await fetch(presign.upload_url, {
                method: 'PUT',
                headers: {'Content-Type': presign.content_type || 'application/octet-stream'},
                body: file,
            })

            if (!putResponse.ok) {throw new Error('Failed to upload file to Spaces.')}

            return {
                bucket: presign.bucket,
                object_key: presign.object_key,
                file_name: presign.file_name,
                content_type: presign.content_type,
            }
        }

        const normalizeFileEntry = async (entry, prefix) => {
            if (!entry?.file) {
                return { ...entry, file: null }
            }
            if (entry.file instanceof File) {
                const uploaded = await uploadFile(entry.file, prefix)
                return { ...entry, file: uploaded }
            }
            return { ...entry }
        }

        const normalizeProfilePhoto = async (profilePhoto, prefix) => {
            if (!profilePhoto) {return null}

            if (profilePhoto instanceof File) {return await uploadFile(profilePhoto, prefix)}

            return profilePhoto
        }

        const buildPersonaPayload = async (persona, prefix) => {
            const normalized = normalizePersona(persona)
            const profile_photo = await normalizeProfilePhoto(normalized.profile_photo, prefix)
            const files = await Promise.all(
                (normalized.files ?? []).map((entry) => normalizeFileEntry(entry, prefix)),
            )
            const referrals = await Promise.all(
                (normalized.referrals ?? []).map(async (referral) => {
                    const normalizedReferral = normalizeReferral(referral)
                    return {
                        conditions: normalizedReferral.conditions,
                        persona: await buildPersonaPayload(normalizedReferral.persona, prefix),
                    }
                }),
            )
            return {
                name: normalized.name,
                role: normalized.role,
                profile_photo,
                known_facts: normalized.known_facts,
                personality_traits: normalized.personality_traits,
                availability_minutes: normalized.availability_minutes,
                files,
                referrals,
            }
        }

        try {
            const prefix = buildPrefix()
            const personasPayload = await Promise.all(
                personas.map((persona) => buildPersonaPayload(persona, prefix)),
            )
            const payload = {
                case_name: caseName.trim(),
                initial_brief: initialBrief.trim(),
                common_information: commonInformation.trim(),
                simulation_duration: simulationDurationMinutes,
                access_code: accessCode.trim(),
                total_non_referred_personas: totalPersonas,
                personas: personasPayload,
            }
            saveMutation.mutate(payload)
        } catch (error) {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        }
    }

    return {submitError, submitSuccess, isSubmitting: saveMutation.isPending, submitCase}
}
